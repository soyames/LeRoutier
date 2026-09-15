// Channels LeRoutier can represent. in_app is always available because it is
// served from our own database; every outbound channel needs a real provider
// and stays unavailable until one is configured. No credentials are invented
// and no channel ever reports success it did not achieve.
export const CHANNELS = ['in_app', 'web_push', 'sms', 'whatsapp', 'email'];
export const CATEGORIES = ['critical', 'operational', 'marketing'];
export const SEVERITIES = ['info', 'warning', 'urgent'];

// Which outbound providers are configured. Unset means unavailable, never a
// silent no-op that looks delivered.
export function channelAvailability(config = {}) {
  const providers = config.notificationProviders ?? {};
  return {
    in_app: true,
    web_push: Boolean(providers.webPushPublicKey && providers.webPushPrivateKey),
    sms: Boolean(providers.sms),
    whatsapp: Boolean(providers.whatsapp),
    email: Boolean(providers.email),
  };
}

// Resolve the channels a notification may actually use, in policy order, with
// in_app always last so a recipient with an account never loses the message.
// Mandatory categories ignore preferences: a passenger cannot switch off a
// payment failure or a boarding-point change.
export function resolveChannels({ policyChannels = [], availability, mandatory = false, category, preferences = [] }) {
  const ordered = [...policyChannels.filter(c => CHANNELS.includes(c) && c !== 'in_app'), 'in_app'];
  return ordered.map(channel => {
    if (!availability[channel]) return { channel, status: 'unavailable', detail: 'No provider configured for this channel.' };
    if (!mandatory) {
      const preference = preferences.find(p => p.category === category && p.channel === channel);
      if (preference && preference.enabled === false) return { channel, status: 'suppressed', detail: 'Disabled by notification preference.' };
    }
    return { channel, status: 'pending', detail: '' };
  });
}

// Raw outbox event helper (used by domain services for business events).
export async function enqueue(tx, type, aggregateId, payload) {
  await tx.query('INSERT INTO outbox (event_type, aggregate_id, payload) VALUES ($1,$2,$3)',
    [type, aggregateId, JSON.stringify(payload)]);
}

// Legacy direct channel send. Retained for the agent workflow actions that
// already depend on it; policy-driven dispatch is the path for domain events.
export async function notify(tx, { channel, to, template, data = {} }) {
  if (!CHANNELS.includes(channel)) throw new Error('Unknown notification channel.');
  if (typeof to !== 'string' || to.length === 0 || to.length > 255) throw new Error('Invalid notification recipient.');
  if (typeof template !== 'string' || template.length === 0 || template.length > 100) throw new Error('Invalid notification template.');
  await tx.query('INSERT INTO outbox (event_type, aggregate_id, payload) VALUES ($1,$2,$3)',
    ['notification.send', to, JSON.stringify({ kind: 'channel', channel, to, template, data })]);
}
