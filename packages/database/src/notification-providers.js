import { confirmationEmail, parcelMessages } from '@leroutier/notifications/content';
import { bookingDocument } from './booking-document.js';

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
    // never receives anything. Both are refusals, not silent drops.
    if (user && (!user.active || user.is_demo)) throw new Error('Recipient unavailable');
    const to = channel === 'email' ? user?.notification_email : notification.contact || user?.phone;
    if (!to) return null;

    if (channel === 'email' && notification.template === 'ticket_ready' && notification.entity_type === 'booking') {
      const booking = await bookingDocument(tx, notification.entity_id);
      if (!booking || booking.is_demo || booking.passenger_id !== notification.user_id) throw new Error('Booking unavailable');
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
  const { apiKey, fromAddress, fromName } = settings;
  // Half-configured produces NO adapter rather than one that fails on the
  // first send — the same rule storage and sign-in follow.
  if (!apiKey || !fromAddress) return null;
  return {
    idempotent: true,
    async send({ notification }) {
      const message = await composeMessage(db, 'email', notification);
      if (!message) return { accepted: false, unavailable: true };
      const response = await fetcher(BREVO_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', accept: 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          sender: { email: fromAddress, ...(fromName ? { name: fromName } : {}) },
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.text,
          ...(message.html ? { htmlContent: message.html } : {}),
        }),
      });
      // Brevo answers 201 with a messageId. Anything else is a failure the
      // dispatcher retries; the provider's own message is never logged,
      // because it echoes the recipient address back.
      if (response.status !== 201 && response.status !== 202) throw new Error('Provider did not accept');
      return { accepted: true };
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
