import { suppression, recordOutcome, isPermanentForMessage, dailyUsage, nextDailyReset } from './notification-channel-state.js';

/**
 * Work the delivery queue.
 *
 * Outbound adapters must guarantee idempotency for the supplied delivery ID.
 * A provider accepting a request is recorded as sent, not handset delivery.
 *
 * WHAT CHANGED AND WHY. This used to treat every failure identically: catch,
 * retry up to five times with backoff, then dead-letter. That is right for a
 * timeout and badly wrong for a daily allowance. Brevo Free sends 300 a day;
 * once spent, the old loop would take every queued notification, attempt it,
 * be refused, and attempt it four more times — hammering a provider that had
 * already said no, and spending tomorrow's rate budget to do it.
 *
 * So a failure now carries a REASON, and the reason decides three things:
 * whether this message is retried, whether the whole channel stops trying, and
 * for how long.
 *
 *   quota_exhausted        the message waits for the allowance to reset. It is
 *                          not failed — it is going to be delivered, later —
 *                          and the channel stops attempting until then, so the
 *                          rest of the queue costs nothing.
 *   rate_limited           the message waits exactly as long as the provider
 *                          asked, then tries again.
 *   provider_unavailable   the existing backoff, unchanged.
 *   invalid_configuration  the message fails immediately. No retry fixes a
 *                          wrong key, and five attempts at one is five wrong
 *                          answers.
 *   recipient_rejected     the message fails immediately. The CHANNEL is fine
 *                          — one bad address must not stop everybody's mail.
 *
 * None of these words ever reaches a passenger. They are written to the
 * delivery audit and read by Platform Ops; what a person sees is their in-app
 * notification, which is served from this database and always works.
 */
export function notificationDelivery(db, adapters = {}, config = {}) {
  const dailyAllowance = config.emailDailyQuota ?? null;

  return {
    async tick() {
      const claimed = await db.transaction(async tx => (await tx.query(`UPDATE notification_deliveries SET
        lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
        WHERE id IN (SELECT id FROM notification_deliveries WHERE status='pending'
          AND (next_attempt_at IS NULL OR next_attempt_at<=now()) AND (lease_until IS NULL OR lease_until<now())
          ORDER BY updated_at LIMIT 25 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows);

      // Channels that have already told us to stop, inside this run. Read once
      // and remembered, so twenty-five queued messages do not each ask.
      const paused = new Map();

      for (const delivery of claimed) {
        let status = 'unavailable', detail = 'provider_unavailable', retrySeconds = null;
        const adapter = adapters[delivery.channel];

        if (delivery.channel === 'in_app') { status = 'sent'; detail = 'inbox_available'; }
        else if (adapter?.idempotent === true && typeof adapter.send === 'function') {
          const pause = paused.get(delivery.channel)
            ?? await db.transaction(tx => suppression(tx, delivery.channel));
          if (pause) paused.set(delivery.channel, pause);

          if (pause) {
            // Suppressed: do not call the provider at all. This is the line
            // that turns a retry storm into one deferred message.
            status = 'pending'; detail = 'channel_' + pause.reason;
            retrySeconds = Math.max(30, Math.ceil((new Date(pause.until).getTime() - Date.now()) / 1000));
          } else {
            const usage = dailyAllowance && delivery.channel === 'email'
              ? await db.transaction(tx => dailyUsage(tx, 'email', dailyAllowance))
              : null;
            if (usage?.exhausted) {
              // We can see the wall before walking into it. Brevo would answer
              // 402; there is no reason to ask it to.
              const until = nextDailyReset();
              await db.transaction(tx => recordOutcome(tx, delivery.channel,
                { outcome: 'quota_exhausted', suppressUntil: until }));
              paused.set(delivery.channel, { until, reason: 'quota_exhausted' });
              status = 'pending'; detail = 'channel_quota_exhausted';
              retrySeconds = Math.max(30, Math.ceil((until.getTime() - Date.now()) / 1000));
            } else {
              const result = await attempt(db, adapter, delivery);
              if (result.kind === 'sent') { status = 'sent'; detail = 'provider_accepted'; }
              else if (result.kind === 'unavailable') { status = 'unavailable'; detail = 'recipient_unavailable'; }
              else {
                const reason = result.reason ?? 'provider_unavailable';
                if (result.suppressUntil) paused.set(delivery.channel, { until: result.suppressUntil, reason });
                if (reason === 'quota_exhausted' || reason === 'rate_limited') {
                  // Keep the message. It has not failed; it is waiting.
                  status = 'pending'; detail = 'channel_' + reason;
                  retrySeconds = Math.max(30, Math.ceil((new Date(result.suppressUntil ?? Date.now() + 60_000).getTime() - Date.now()) / 1000));
                } else if (isPermanentForMessage(reason)) {
                  status = 'failed'; detail = reason;
                } else {
                  status = delivery.attempts >= 5 ? 'failed' : 'pending';
                  detail = status === 'failed' ? 'dead_letter' : 'retry_scheduled';
                }
              }
            }
          }
        }

        await db.transaction(async tx => {
          const backoff = retrySeconds ?? Math.min(3600, 30 * 2 ** delivery.attempts);
          await tx.query(`UPDATE notification_deliveries SET status=$2,detail=$3,lease_until=NULL,updated_at=now(),
            next_attempt_at=CASE WHEN $2='pending' THEN now()+make_interval(secs=>$4) ELSE NULL END WHERE id=$1`,
          [delivery.id, status, detail, backoff]);
          await tx.query('INSERT INTO notification_delivery_attempts(delivery_id,status) VALUES($1,$2)', [delivery.id, detail]);
        });
      }
      return { processed: claimed.length };
    },
  };
}

/**
 * One provider attempt, with the outcome recorded against the channel.
 *
 * An adapter may report a failure by returning a reason or by throwing; a throw
 * carries no classification, so it is treated as the provider being
 * unavailable — the conservative reading, because it retries rather than
 * discarding somebody's ticket confirmation.
 */
async function attempt(db, adapter, delivery) {
  let result;
  try {
    const notification = await db.transaction(async tx =>
      (await tx.query('SELECT * FROM notifications WHERE id=$1', [delivery.notification_id])).rows[0]);
    result = await adapter.send({ notification, idempotencyKey: delivery.id });
  } catch {
    return { kind: 'failed', reason: 'provider_unavailable' };
  }

  if (result?.unavailable === true) return { kind: 'unavailable' };

  const observation = {
    rateLimitRemaining: result?.rateLimitRemaining ?? null,
    rateLimitResetsAt: result?.rateLimitResetsAt ?? null,
  };
  if (result?.accepted === true) {
    await db.transaction(tx => recordOutcome(tx, delivery.channel, { outcome: 'sent', ...observation }))
      .catch(() => { /* recording state must never lose a successful send */ });
    return { kind: 'sent' };
  }

  const reason = result?.reason ?? 'provider_unavailable';
  const suppressUntil = result?.suppressUntil ?? null;
  await db.transaction(tx => recordOutcome(tx, delivery.channel, { outcome: reason, suppressUntil, ...observation }))
    .catch(() => { /* a failure to record must not change the delivery outcome */ });
  return { kind: 'failed', reason, suppressUntil };
}
