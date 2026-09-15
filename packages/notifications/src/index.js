// Channels LeRoutier can represent today: the outbox already carries every
// event needed for delivery; provider integrations (SMS, WhatsApp, email) are
// intentionally not wired yet and no credentials are invented.
export const CHANNELS = ['in_app', 'sms', 'whatsapp', 'email'];

// Channel-aware notification. Called inside the same transaction as the
// business operation; a future channel worker consumes these outbox events.
export async function notify(tx, { channel, to, template, data = {} }) {
  if (!CHANNELS.includes(channel)) throw new Error('Unknown notification channel.');
  if (typeof to !== 'string' || to.length === 0 || to.length > 255) throw new Error('Invalid notification recipient.');
  if (typeof template !== 'string' || template.length === 0 || template.length > 100) throw new Error('Invalid notification template.');
  await tx.query('INSERT INTO outbox (event_type, aggregate_id, payload) VALUES ($1,$2,$3)',
    ['notification.send', to, JSON.stringify({ kind: 'channel', channel, to, template, data })]);
}

// Raw outbox event helper (used by domain services for business events).
export async function enqueue(tx, type, aggregateId, payload) {
  await tx.query('INSERT INTO outbox (event_type, aggregate_id, payload) VALUES ($1,$2,$3)',
    [type, aggregateId, JSON.stringify(payload)]);
}
