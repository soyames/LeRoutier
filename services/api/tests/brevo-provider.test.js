// The first external notification channel, against a fake Brevo.
//
// No real message is ever sent from a test — the transport is a function, and
// asserting what it was handed is the point. What is under test is that the
// adapter fits the existing abstraction rather than replacing it, that a TEST
// identity can never reach it, and that a contact address never appears
// anywhere it should not.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { notificationProviders } from '@leroutier/database/notification-providers';
import { channelAvailability } from '@leroutier/notifications';
import { serverConfig } from '@leroutier/config';

const db = createDatabase({ ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', '') });
const BREVO = { emailProvider: 'brevo', brevo: { apiKey: 'test-brevo-key', fromAddress: 'ne-pas-repondre@leroutier.app', fromName: 'LeRoutier' } };

let realPerson, testPerson, disabledPerson;

/** Records what the transport was asked to do; never reaches the network. */
function fakeBrevo({ status = 201 } = {}) {
  const calls = [];
  return {
    calls,
    fetcher: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ messageId: '<test@brevo>' }), { status });
    },
  };
}

const notification = (userId, extra = {}) => ({
  id: randomUUID(), user_id: userId, channel: 'email', template: 'parcel_ready_for_pickup',
  entity_type: 'parcel', entity_id: randomUUID(), contact: null, data: { trackingNumber: 'LRP-TEST01' }, ...extra,
});

before(async () => {
  await migrate(db);
  await db.transaction(async tx => {
    const make = async (name, email, isDemo) => {
      const { rows } = await tx.query(
        `INSERT INTO users(display_name,role,notification_email,is_demo,active)
         VALUES($1,'passenger',$2,$3,$4) RETURNING id`,
        [name, email, isDemo, name !== 'Disabled']);
      return rows[0].id;
    };
    realPerson = await make('Real', 'voyageur@example.invalid', false);
    testPerson = await make('TEST Person', 'test@example.invalid', true);
    disabledPerson = await make('Disabled', 'disabled@example.invalid', false);
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('brevo is selected only when configured, and only for email', async () => {
  // Nothing configured: no outbound channel is invented.
  assert.deepEqual(Object.keys(notificationProviders(db, { notificationProviders: {} })), []);
  // Half-configured produces no adapter rather than one that fails on first use.
  for (const half of [{ apiKey: 'k' }, { fromAddress: 'a@b.invalid' }, {}]) {
    const providers = notificationProviders(db, { notificationProviders: { emailProvider: 'brevo', brevo: half } });
    assert.deepEqual(Object.keys(providers), [], `half-configured (${Object.keys(half)}) must produce no adapter`);
  }
  const providers = notificationProviders(db, { notificationProviders: BREVO }, fakeBrevo().fetcher);
  assert.deepEqual(Object.keys(providers), ['email'], 'configuring email must not invent sms or whatsapp');

  // And the capability the console reports follows from that, not from a flag.
  const availability = channelAvailability({ notificationProviders: providers });
  assert.equal(availability.email, true);
  assert.equal(availability.sms, false);
  assert.equal(availability.whatsapp, false);
  assert.equal(availability.in_app, true, 'in-app remains the fallback that always works');
});

test('a real recipient produces one well-formed Brevo request', async () => {
  const brevo = fakeBrevo();
  const { email } = notificationProviders(db, { notificationProviders: BREVO }, brevo.fetcher);
  const result = await email.send({ notification: notification(realPerson), idempotencyKey: randomUUID() });

  assert.deepEqual(result, { accepted: true });
  assert.equal(brevo.calls.length, 1);
  const call = brevo.calls[0];
  assert.equal(call.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(call.headers['api-key'], 'test-brevo-key');
  assert.equal(call.body.sender.email, 'ne-pas-repondre@leroutier.app');
  assert.deepEqual(call.body.to, [{ email: 'voyageur@example.invalid' }]);
  assert.match(call.body.textContent, /LRP-TEST01/);
  assert.match(call.body.textContent, /LeRoutier/);
});

test('a TEST identity never reaches the provider, and neither does a disabled account', async () => {
  for (const person of [testPerson, disabledPerson]) {
    const brevo = fakeBrevo();
    const { email } = notificationProviders(db, { notificationProviders: BREVO }, brevo.fetcher);
    await assert.rejects(email.send({ notification: notification(person), idempotencyKey: randomUUID() }));
    assert.equal(brevo.calls.length, 0, 'the request must not be made at all, not merely discarded');
  }
});

test('a recipient with no address is unavailable, not a failure to retry forever', async () => {
  const noAddress = await db.transaction(async tx => (await tx.query(
    "INSERT INTO users(display_name,role,active) VALUES('No Address','passenger',true) RETURNING id")).rows[0].id);
  const brevo = fakeBrevo();
  const { email } = notificationProviders(db, { notificationProviders: BREVO }, brevo.fetcher);
  const result = await email.send({ notification: notification(noAddress), idempotencyKey: randomUUID() });
  assert.deepEqual(result, { accepted: false, unavailable: true });
  assert.equal(brevo.calls.length, 0);
});

test('a provider refusal throws so the dispatcher retries, and never reports sent', async () => {
  for (const status of [400, 401, 429, 500, 503]) {
    const brevo = fakeBrevo({ status });
    const { email } = notificationProviders(db, { notificationProviders: BREVO }, brevo.fetcher);
    await assert.rejects(email.send({ notification: notification(realPerson), idempotencyKey: randomUUID() }),
      undefined, `HTTP ${status} must not be treated as accepted`);
  }
});

test('the API key never travels in a URL, a body, or anything returned to a caller', async () => {
  const brevo = fakeBrevo();
  const { email } = notificationProviders(db, { notificationProviders: BREVO }, brevo.fetcher);
  const result = await email.send({ notification: notification(realPerson), idempotencyKey: randomUUID() });
  const call = brevo.calls[0];
  assert.ok(!call.url.includes('test-brevo-key'), 'a key in a URL ends up in every log and proxy');
  assert.ok(!JSON.stringify(call.body).includes('test-brevo-key'));
  assert.ok(!JSON.stringify(result).includes('test-brevo-key'));
  // And the result carries no contact detail back to the dispatcher, which
  // writes what it is given into the delivery audit.
  assert.ok(!JSON.stringify(result).includes('voyageur@example.invalid'));
});

test('the gateway contract still works, so adding brevo replaced nothing', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  };
  const providers = notificationProviders(db, {
    notificationProviders: { email: { url: 'https://relay.example.invalid/send', key: 'relay-key' } },
  }, fetcher);
  const key = randomUUID();
  assert.deepEqual(await providers.email.send({ notification: notification(realPerson), idempotencyKey: key }),
    { accepted: true });
  assert.equal(calls[0].url, 'https://relay.example.invalid/send');
  assert.equal(calls[0].headers['idempotency-key'], key,
    'the gateway contract deduplicates on this key and must keep receiving it');

  // A plaintext relay is refused rather than used.
  assert.deepEqual(Object.keys(notificationProviders(db, {
    notificationProviders: { email: { url: 'http://relay.example.invalid/send', key: 'k' } },
  }, fetcher)), []);
});
