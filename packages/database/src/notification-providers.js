import { confirmationEmail, parcelMessages } from '@leroutier/notifications/content';
import { bookingDocument } from './booking-document.js';
import { nextDailyReset } from './notification-channel-state.js';

/**
 * Outbound notification transports.
 *
 * Two shapes, one contract. Every adapter exposes `{idempotent, send}`; the
 * dispatcher calls `send({notification, idempotencyKey})` and treats anything
 * but `{accepted:true}` as a failure to retry. Nothing here invents a channel:
 * a channel with no credentials stays unavailable, and an unavailable channel
 * is recorded as unavailable rather than as sent.
 *
 *   GATEWAY  EMAIL_PROVIDER_URL + EMAIL_PROVIDER_KEY (and the SMS/WhatsApp
 *            equivalents). A relay the owner runs, speaking LeRoutier's own
 *            contract. Kept because it is the only shape that can reach a
 *            channel nobody has written an adapter for.
 *
 *   BREVO    EMAIL_PROVIDER=brevo + BREVO_API_KEY. Speaks Brevo's REST API
 *            directly, so the owner needs an account and an API key rather
 *            than a relay to run.
 *
 * ON IDEMPOTENCY, precisely. `idempotent:true` is what tells the dispatcher an
 * adapter is safe to call with a stable key, and the dispatcher is what
 * prevents duplicates: a delivery it records as `sent` is never retried, so a
 * retry only happens where the provider was NOT observed to accept. Brevo has
 * no idempotency-key header, so one window remains — the provider accepts and
 * the process dies before recording it, after which the retry sends again.
 * That is at-least-once, and it is the right trade for this content: a
 * passenger receiving their ticket confirmation twice is a nuisance, and never
 * receiving it is a passenger at a station without a ticket. Said plainly here
 * rather than implied by a flag.
 */

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/**
 * What a Brevo response actually means, in LeRoutier's vocabulary.
 *
 * The whole point is that these five are not the same thing. A spent daily
 * allowance and a timed-out request both "fail", and retrying one is correct
 * while retrying the other is a retry storm against a provider that has
 * already said no.
 *
 *   402 / not_enough_credits  the plan's allowance is spent. Brevo Free sends
 *                             300 a day; past that this is what it answers.
 *   429                       too many requests. Retry, but only when told.
 *   401 / 403                 wrong key, or a sender Brevo will not accept.
 *                             No retry fixes either.
 *   400                       the request was refused. For a transactional
 *                             send with a server-built body, the realistic
 *                             cause is the address.
 *   5xx / network             the provider. The existing backoff is right.
 *
 * Returns a reason only; the provider's own message is deliberately discarded,
 * because it echoes the recipient address back and would end up in the
 * delivery audit.
 */
export function classifyBrevoFailure(status, code) {
  if (status === 402 || code === 'not_enough_credits') return 'quota_exhausted';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'invalid_configuration';
  if (status === 400) {
    // Brevo names the sender problems explicitly; anything else at 400 on a
    // body we built ourselves is the address.
    if (code === 'invalid_parameter' || code === 'missing_parameter') return 'recipient_rejected';
    if (code === 'unauthorized' || code === 'not_enabled') return 'invalid_configuration';
    return 'recipient_rejected';
  }
  return 'provider_unavailable';
}

/** Brevo reports the request-rate budget on every response, not only on 429. */
function rateLimit(headers, now = new Date()) {
  const remaining = Number(headers.get('x-sib-ratelimit-remaining'));
  const resetSeconds = Number(headers.get('x-sib-ratelimit-reset'));
  const retryAfter = Number(headers.get('retry-after'));
  const seconds = Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds
    : Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetsAt: seconds === null ? null : new Date(now.getTime() + Math.min(3600, seconds) * 1000),
  };
}

/**
 * One Brevo transactional HTTP request, shared by the notification adapter and
 * the standalone transactional sender (account verification, whose recipients
 * are NOT notification rows yet — an unverified account has no users.id and no
 * verified address to compose from). The key rides a header, never the URL,
 * and the failure body is read for its CODE only.
 *
 * @param {{apiKey?:string,fromAddress?:string,fromName?:string}} settings
 * @param {{to:string,subject:string,text:string,html?:string}} message
 * @param {typeof fetch} fetcher
 */
async function brevoSend(settings, message, fetcher) {
  let response;
  try {
    response = await fetcher(BREVO_ENDPOINT, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'api-key': settings.apiKey },
      body: JSON.stringify({
        sender: { email: settings.fromAddress, ...(settings.fromName ? { name: settings.fromName } : {}) },
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
        ...(message.html ? { htmlContent: message.html } : {}),
      }),
    });
  } catch {
    // A timeout or a DNS failure is the provider being unreachable, and is
    // the one case where we genuinely do not know whether it arrived.
    return { accepted: false, reason: 'provider_unavailable', rateLimitRemaining: null, rateLimitResetsAt: null };
  }
  const budget = rateLimit(response.headers);
  // Brevo answers 201 (or 202) with a messageId.
  if (response.status === 201 || response.status === 202) {
    return { accepted: true, rateLimitRemaining: budget.remaining, rateLimitResetsAt: budget.resetsAt };
  }
  // The body is read for its CODE and nothing else. Brevo's message echoes
  // the recipient address back, and that must not reach the delivery audit
  // or any console.
  const code = await response.json().then(body => body?.code ?? null).catch(() => null);
  return { accepted: false, reason: classifyBrevoFailure(response.status, code),
    rateLimitRemaining: budget.remaining, rateLimitResetsAt: budget.resetsAt };
}

/**
 * A standalone Brevo sender, for transactional messages whose recipients are
 * not notification rows: the account-verification email is the one. Same
 * endpoint, same key, same sender, same failure vocabulary as the notification
 * adapter — this is a second entry point to one provider, not a second system.
 *
 * @param {{apiKey?:string,fromAddress?:string,fromName?:string}} [settings]
 * @param {typeof fetch} [fetcher]
 */
export function brevoTransactionalSender(settings = {}, fetcher = fetch) {
  if (!settings.apiKey || !settings.fromAddress) {
    // Half-configured produces no sender rather than one that fails on the
    // first send — the same rule the adapter follows.
    return { available: false, async send() { return { accepted: false, reason: 'invalid_configuration' }; } };
  }
  return { available: true, send: message => brevoSend(settings, message, fetcher) };
}

/**
 * Turn a queued notification into the message a transport will carry.
 *
 * Shared by every adapter so the wording, the recipient rule and the refusals
 * cannot drift apart between transports. Returns null when there is nobody to
 * send to, which the dispatcher records as `recipient_unavailable` rather than
 * as a failure to retry forever.
 */
async function composeMessage(db, channel, notification) {
  return db.transaction(async tx => {
    const user = notification.user_id
      ? (await tx.query('SELECT u.notification_email,u.active,u.is_demo,p.phone FROM users u LEFT JOIN passenger_profiles p ON p.user_id=u.id WHERE u.id=$1', [notification.user_id])).rows[0]
      : null;
    // A TEST identity never reaches a real gateway, and a disabled account
    // never receives anything. Returned as "nobody to send to" rather than
    // thrown: a throw reads as a provider failure, which would retry five
    // times and — now that failures colour the channel's health — let TEST
    // data suppress real people's email.
    if (user && (!user.active || user.is_demo)) return null;
    const to = channel === 'email' ? user?.notification_email : notification.contact || user?.phone;
    if (!to) return null;

    if (channel === 'email' && notification.template === 'ticket_ready' && notification.entity_type === 'booking') {
      const booking = await bookingDocument(tx, notification.entity_id);
      // Same reasoning: a booking that is not this person's, or is TEST data,
      // is nobody to send to rather than a provider that broke.
      if (!booking || booking.is_demo || booking.passenger_id !== notification.user_id) return null;
      return { channel, to, ...confirmationEmail(booking) };
    }
    const number = notification.data?.trackingNumber;
    return {
      channel, to,
      subject: 'LeRoutier',
      text: `LeRoutier · ${parcelMessages[notification.template] || 'Une mise à jour est disponible dans votre compte.'}`
        + (number
          ? ` · ${number} · https://leroutier.app/parcels/track?ref=${encodeURIComponent(number)}`
          : ' https://leroutier.app'),
    };
  });
}

/** The owner's own relay, speaking LeRoutier's contract. */
function gatewayAdapter(db, channel, provider, fetcher) {
  try { if (new URL(provider.url).protocol !== 'https:') return null; } catch { return null; }
  return {
    idempotent: true,
    async send({ notification, idempotencyKey }) {
      const message = await composeMessage(db, channel, notification);
      if (!message) return { accepted: false, unavailable: true };
      const response = await fetcher(provider.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + provider.key, 'idempotency-key': idempotencyKey },
        body: JSON.stringify(message),
      });
      if (!response.ok || (await response.json())?.accepted !== true) throw new Error('Provider did not accept');
      return { accepted: true };
    },
  };
}

/**
 * Brevo transactional email.
 *
 * Chosen because it is the only channel that is genuinely free for a pilot in
 * Benin without activating billing anywhere: 300 messages a day, no card, full
 * REST API on the free tier. SMS to Benin is metered by every provider, and
 * WhatsApp needs a Meta Business account and template review, so neither can
 * be switched on without a commitment the owner has not made.
 *
 * The sender address must be one Brevo has verified, and Brevo requires the
 * account itself to be approved before it will send anything — which is why
 * this reports its capability from configuration and never claims delivery it
 * has not achieved.
 */
function brevoAdapter(db, settings, fetcher) {
  const { apiKey, fromAddress } = settings;
  // Half-configured produces NO adapter rather than one that fails on the
  // first send — the same rule storage and sign-in follow.
  if (!apiKey || !fromAddress) return null;
  return {
    idempotent: true,
    async send({ notification }) {
      const message = await composeMessage(db, 'email', notification);
      if (!message) return { accepted: false, unavailable: true };
      const result = await brevoSend(settings, message, fetcher);
      if (result.accepted) return result;
      return {
        accepted: false,
        reason: result.reason,
        rateLimitRemaining: result.rateLimitRemaining,
        rateLimitResetsAt: result.rateLimitResetsAt,
        // A spent allowance lasts until the day rolls over; a rate limit lasts
        // as long as Brevo says, and a minute if it did not say.
        suppressUntil: result.reason === 'quota_exhausted' ? nextDailyReset()
          : result.reason === 'rate_limited' ? (result.rateLimitResetsAt ?? new Date(Date.now() + 60_000))
            : result.reason === 'invalid_configuration' ? nextDailyReset()
              : null,
      };
    },
  };
}

/**
 * Which outbound transports this deployment actually has.
 *
 * @param {object} db
 * @param {object} config
 * @param {typeof fetch} [fetcher]
 */
export function notificationProviders(db, config, fetcher = fetch) {
  const settings = config.notificationProviders ?? {};
  return Object.fromEntries(['email', 'sms', 'whatsapp'].flatMap(channel => {
    const provider = settings[channel];
    // An adapter supplied directly (tests, and any future in-process transport)
    // wins, so a suite never depends on the network.
    if (provider?.idempotent === true && typeof provider.send === 'function') return [[channel, provider]];
    if (channel === 'email' && settings.emailProvider === 'brevo') {
      const adapter = brevoAdapter(db, settings.brevo ?? {}, fetcher);
      return adapter ? [['email', adapter]] : [];
    }
    if (!provider?.url || !provider?.key) return [];
    const adapter = gatewayAdapter(db, channel, provider, fetcher);
    return adapter ? [[channel, adapter]] : [];
  }));
}
