/**
 * Whether an outbound channel may attempt right now, and what to say about it.
 *
 * READ THIS BEFORE CHANGING A FAILURE PATH.
 *
 * Five different things go wrong when sending email, and treating them as one
 * "it failed" is how a daily allowance of 300 turns into fifteen hundred
 * refused requests:
 *
 *   quota_exhausted        the plan's allowance for the period is spent.
 *                          Retrying before it resets cannot succeed. Suppress
 *                          the whole channel until the reset, do not fail the
 *                          message — it is still going to be delivered, later.
 *
 *   rate_limited           too many requests too quickly. Retrying is correct,
 *                          but only after the provider says we may. Suppress
 *                          briefly, keep the message.
 *
 *   provider_unavailable   the provider erred or could not be reached. The
 *                          existing backoff is exactly right for this.
 *
 *   invalid_configuration  the credential or the sender is wrong. No amount of
 *                          retrying fixes a wrong key, so the message fails
 *                          immediately rather than five times, and the channel
 *                          is suppressed until somebody corrects it.
 *
 *   recipient_rejected     this address will never accept this message. The
 *                          message fails permanently. The CHANNEL is fine and
 *                          is not suppressed — one bad address must not stop
 *                          everybody else's mail.
 *
 * NOTHING HERE IS USER-FACING. These words are LeRoutier's, not the provider's,
 * and even so they live in the delivery audit and the Platform Ops console
 * only. A passenger is never shown a provider name, an HTTP status, a quota
 * message or an API error; they are shown that the external send is
 * unavailable, and their in-app notification, which always works.
 */
import { invariant } from '@leroutier/domain';

export const FAILURE_REASONS = Object.freeze([
  'quota_exhausted', 'rate_limited', 'provider_unavailable', 'invalid_configuration', 'recipient_rejected',
]);

/** Reasons that suppress the whole channel rather than just failing one message. */
const SUPPRESSES_CHANNEL = Object.freeze(['quota_exhausted', 'rate_limited', 'provider_unavailable', 'invalid_configuration']);

/** Reasons where retrying this message cannot help. */
const PERMANENT_FOR_MESSAGE = Object.freeze(['recipient_rejected', 'invalid_configuration']);

export const suppressesChannel = reason => SUPPRESSES_CHANNEL.includes(reason);
export const isPermanentForMessage = reason => PERMANENT_FOR_MESSAGE.includes(reason);

/**
 * When the provider's daily allowance next resets.
 *
 * Midnight UTC, which is the conservative choice: if the account's day rolls
 * over earlier we simply resume a little late, whereas guessing a local
 * timezone and being wrong the other way means walking straight back into the
 * wall. A real refusal re-suppresses anyway, so the cost of being cautious is
 * a short delay and the cost of being wrong is a retry storm.
 */
export function nextDailyReset(now = new Date()) {
  const reset = new Date(now);
  reset.setUTCHours(24, 0, 0, 0);
  return reset;
}

/**
 * Read a channel's current state. Never throws for a missing row: a channel
 * nobody has recorded anything about is simply one that has not failed yet.
 */
export async function channelState(tx, channel) {
  const { rows } = await tx.query('SELECT * FROM notification_channel_state WHERE channel=$1', [channel]);
  return rows[0] ?? null;
}

/** Whether a channel is currently suppressed, and until when. */
export async function suppression(tx, channel, now = new Date()) {
  const state = await channelState(tx, channel);
  if (!state?.suppressed_until) return null;
  if (new Date(state.suppressed_until) <= now) return null;
  return { until: state.suppressed_until, reason: state.suppression_reason };
}

/**
 * Record an outcome, and suppress the channel when the outcome says the whole
 * channel is the problem rather than one message.
 *
 * @param {object} tx
 * @param {string} channel
 * @param {{outcome: string, suppressUntil?: Date|null, rateLimitRemaining?: number|null,
 *   rateLimitResetsAt?: Date|null}} observation
 */
export async function recordOutcome(tx, channel, observation) {
  const { outcome, suppressUntil = null, rateLimitRemaining = null, rateLimitResetsAt = null } = observation;
  invariant(outcome === 'sent' || FAILURE_REASONS.includes(outcome), 'INTERNAL_ERROR',
    'Unknown notification outcome.', 500);
  const reason = outcome === 'sent' ? null : suppressUntil ? outcome : null;
  await tx.query(`
    INSERT INTO notification_channel_state
      (channel, suppressed_until, suppression_reason, rate_limit_remaining, rate_limit_resets_at,
       last_outcome, last_outcome_at, last_success_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,now(), CASE WHEN $6='sent' THEN now() END, now())
    ON CONFLICT (channel) DO UPDATE SET
      -- A success clears suppression outright: whatever was wrong is not wrong
      -- any more, and that is the only honest way to leave an
      -- invalid_configuration state, which has no natural expiry.
      suppressed_until    = CASE WHEN $6='sent' THEN NULL ELSE COALESCE($2, notification_channel_state.suppressed_until) END,
      suppression_reason  = CASE WHEN $6='sent' THEN NULL ELSE COALESCE($3, notification_channel_state.suppression_reason) END,
      rate_limit_remaining = COALESCE($4, notification_channel_state.rate_limit_remaining),
      rate_limit_resets_at = COALESCE($5, notification_channel_state.rate_limit_resets_at),
      last_outcome = $6,
      last_outcome_at = now(),
      last_success_at = CASE WHEN $6='sent' THEN now() ELSE notification_channel_state.last_success_at END,
      updated_at = now()`,
  [channel, suppressUntil, reason, rateLimitRemaining, rateLimitResetsAt, outcome]);
}

/**
 * How much of today's allowance this platform has already spent.
 *
 * Counted from OUR OWN delivery ledger rather than asked of the provider:
 * it costs no request, it cannot be rate-limited, and it is the number that
 * actually matters — what LeRoutier sent. The provider's own refusal is still
 * authoritative when it comes, and suppresses the channel regardless of what
 * this count said.
 */
export async function dailyUsage(tx, channel, dailyAllowance) {
  const { rows } = await tx.query(`
    SELECT count(*)::int AS sent FROM notification_deliveries
    WHERE channel=$1 AND status='sent' AND updated_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`, [channel]);
  const sent = rows[0]?.sent ?? 0;
  const allowance = Number.isInteger(dailyAllowance) && dailyAllowance > 0 ? dailyAllowance : null;
  return {
    sent,
    allowance,
    remaining: allowance === null ? null : Math.max(0, allowance - sent),
    // Pressure is what a console should colour on, and null when no allowance
    // is configured rather than a made-up 0%.
    usedPercent: allowance === null ? null : Math.min(100, Math.round((sent / allowance) * 100)),
    exhausted: allowance !== null && sent >= allowance,
  };
}

/**
 * Default thresholds for a 300-a-day allowance.
 *
 * Deliberately conservative: at 85% of 300 there are 45 emails left, which is
 * not many if a coach cancels. Overridable through configuration, because a
 * different plan wants different numbers and hard-coding them here would make
 * the plan a code change.
 */
/** @type {{warning:number,high:number,critical:number}} */
export const DEFAULT_QUOTA_THRESHOLDS = Object.freeze({ warning: 70, high: 85, critical: 95 });

/**
 * One word for how the email channel is doing, for the console and for the
 * admission rule below.
 *
 * Provider states outrank usage: being rate-limited or misconfigured matters
 * more than being at 40% of the day's allowance, and reporting "healthy"
 * while the credential is wrong would be exactly the kind of green badge this
 * project refuses.
 */
/**
 * @param {{sent?:number, allowance?:number|null, remaining?:number|null, usedPercent?:number|null, exhausted?:boolean}|null} usage
 * @param {{suppressed_until?:Date|string|null, suppression_reason?:string|null}|null} [state]
 * @param {{warning:number,high:number,critical:number}} [thresholds]
 * @param {Date} [now]
 */
export function quotaPressure(usage, state = null, thresholds = DEFAULT_QUOTA_THRESHOLDS, now = new Date()) {
  const suppressed = state?.suppressed_until && new Date(state.suppressed_until) > now
    ? state.suppression_reason : null;
  if (suppressed === 'invalid_configuration') return 'configuration_error';
  if (suppressed === 'rate_limited') return 'provider_rate_limited';
  if (suppressed === 'provider_unavailable') return 'provider_unavailable';
  if (suppressed === 'quota_exhausted' || usage?.exhausted) return 'quota_exhausted';
  // No configured allowance means no honest percentage to report.
  if (usage?.usedPercent === null || usage?.usedPercent === undefined) return 'healthy';
  if (usage.usedPercent >= thresholds.critical) return 'critical';
  if (usage.usedPercent >= thresholds.high) return 'high';
  if (usage.usedPercent >= thresholds.warning) return 'warning';
  return 'healthy';
}

/**
 * Whether an email of this importance may still be created today.
 *
 * Spends the last of the allowance on the messages somebody has to act on: a
 * cancelled trip, a rejected document, a failed payout, a parcel waiting to be
 * collected. What is refused here is only the EMAIL — the notification is
 * still created, still delivered in-app, and still read exactly as before,
 * because the application is where LeRoutier's state lives and the inbox is a
 * courtesy.
 */
export function emailAdmitted(importance, pressure) {
  if (pressure === 'configuration_error') return false;
  if (pressure === 'quota_exhausted' || pressure === 'critical') return importance === 'high';
  if (pressure === 'high') return importance !== 'optional';
  return true;
}
