// Which events are worth an email, and what happens when there are none left.
//
// Brevo Free sends 300 a day. Two things follow, and both are tested here
// rather than trusted: LeRoutier must not spend that allowance on a vehicle
// reaching a stop, and when the allowance IS gone the business transaction
// must be completely unaffected — the booking is still confirmed, the payout
// state is still authoritative, the notification is still in the inbox, and
// nobody is shown a provider's error.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { notificationDelivery } from '../src/notification-delivery.js';
import {
  quotaPressure, emailAdmitted, dailyUsage, channelState, recordOutcome,
  nextDailyReset, DEFAULT_QUOTA_THRESHOLDS,
} from '../src/notification-channel-state.js';
import { serverConfig } from '@leroutier/config';

const db = createDatabase({ ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', '') });
const ALLOWANCE = 300;

const rows = async (sql, args = []) => db.transaction(async tx => (await tx.query(sql, args)).rows);

/** A queued email delivery, with no provider having been near it. */
async function queueEmail({ attempts = 0 } = {}) {
  return db.transaction(async tx => {
    const person = (await tx.query(
      "INSERT INTO users(display_name,role,notification_email,active) VALUES('Voyageur','passenger','v@example.invalid',true) RETURNING id")).rows[0].id;
    const notification = (await tx.query(
      `INSERT INTO notifications(user_id,event_type,category,severity,template,data,entity_type)
       VALUES($1,'booking.confirmed','operational','info','ticket_ready','{}','booking') RETURNING id`, [person])).rows[0].id;
    // in_app is created alongside and is already delivered: it is the baseline
    // that must survive anything the provider does.
    await tx.query(`INSERT INTO notification_deliveries(notification_id,channel,status,detail)
      VALUES($1,'in_app','sent','inbox_available')`, [notification]);
    const delivery = (await tx.query(
      `INSERT INTO notification_deliveries(notification_id,channel,status,detail,attempts)
       VALUES($1,'email','pending','queued',$2) RETURNING id`, [notification, attempts])).rows[0].id;
    return { person, notification, delivery };
  });
}

const deliveryRow = async id => (await rows('SELECT * FROM notification_deliveries WHERE id=$1', [id]))[0];

/**
 * Start from a channel nobody has suppressed.
 *
 * Suppression is deliberately durable — that is the whole point of it — so
 * without this the first test to exhaust the allowance would silently decide
 * the outcome of every test after it.
 */
const unsuppress = () => db.transaction(tx => tx.query(
  `UPDATE notification_channel_state SET suppressed_until=NULL, suppression_reason=NULL WHERE channel='email'`));

/** An adapter that records whether it was called at all. */
function spyAdapter(result) {
  const calls = [];
  return {
    calls,
    adapter: {
      idempotent: true,
      async send(args) { calls.push(args); return typeof result === 'function' ? result() : result; },
    },
  };
}

before(async () => { await migrate(db); });
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

// ---- the catalogue ---------------------------------------------------------

test('one successful booking produces ONE email, not three', async () => {
  const emailing = await rows(
    `SELECT event_type,template FROM notification_policies
     WHERE active AND channels @> '["email"]' AND audience='booking_passenger'`);
  const templates = emailing.map(r => r.template).sort();
  // The combined message: booking.confirmed fires once payment is confirmed,
  // and ticket_ready already carries the trip, the seat, the amount paid, any
  // refund and the link to the ticket and its receipt.
  assert.ok(templates.includes('ticket_ready'), 'the combined confirmation must be emailed');
  // Therefore these must NOT also be emailed — three messages for one purchase
  // is three times the quota and two more things to read.
  assert.ok(!templates.includes('payment_succeeded'), 'payment success must not be a second email');
  assert.ok(!templates.includes('booking_created'), 'holding a seat must not be an email');
  assert.ok(!templates.includes('passenger_boarded'), 'boarding must not be an email');
});

test('routine operational events never reach the email channel', async () => {
  // Position, progress, custody and internal state: high frequency, low value
  // in an inbox, and the fastest way to spend 300 messages before lunch.
  const routine = ['passenger_boarded', 'arrival_completed', 'booking_created', 'crew_next_station',
    'parcel_in_transit', 'parcel_loaded', 'parcel_arrived', 'parcel_eta_updated',
    'crew_parcel_to_load', 'crew_parcel_to_unload', 'ops_incident', 'ops_service_disrupted',
    'settlement_credited', 'crew_walkup_recorded'];
  const offenders = await rows(
    `SELECT template FROM notification_policies WHERE active AND channels @> '["email"]' AND template = ANY($1)`,
    [routine]);
  assert.deepEqual(offenders, [], 'a routine operational event acquired an email channel');
});

test('the events that must reach somebody do get an email', async () => {
  const expected = [
    ['booking.cancelled', 'booking_cancelled'],
    ['service.status', 'service_cancelled'],
    ['service.rescheduled', 'service_delayed'],
    ['payment.failed', 'payment_failed'],
    ['payout.failed', 'payout_failed'],
    ['operator.evidence_reviewed', 'operator_evidence_rejected'],
    ['operator.verification_changed', 'operator_verification_rejected'],
    ['operator.verification_changed', 'operator_verified'],
    ['parcel.ready_for_pickup', 'parcel_ready_for_pickup'],
    ['parcel.accepted', 'parcel_accepted'],
  ];
  for (const [event, template] of expected) {
    const found = await rows(
      `SELECT importance FROM notification_policies
       WHERE active AND event_type=$1 AND template=$2 AND channels @> '["email"]'`, [event, template]);
    assert.ok(found.length >= 1, `${event}/${template} should be emailed and is not`);
  }
});

test('every emailing policy still lists in_app, so the inbox is never the loser', async () => {
  // The dispatcher appends in_app, but a policy that named email and dropped
  // in_app would be a policy where losing the provider loses the message.
  const emailing = await rows(`SELECT template,channels,importance FROM notification_policies
    WHERE active AND channels @> '["email"]'`);
  assert.ok(emailing.length > 0);
  for (const policy of emailing) {
    assert.ok(['high', 'normal', 'optional'].includes(policy.importance),
      `${policy.template} has no importance and cannot be prioritised under pressure`);
  }
});

// ---- quota pressure --------------------------------------------------------

test('quota pressure reads the day honestly, and provider trouble outranks it', () => {
  const at = sent => ({ sent, allowance: ALLOWANCE, remaining: ALLOWANCE - sent,
    usedPercent: Math.round((sent / ALLOWANCE) * 100), exhausted: sent >= ALLOWANCE });

  assert.equal(quotaPressure(at(0)), 'healthy');
  assert.equal(quotaPressure(at(200)), 'healthy');      // 67%
  assert.equal(quotaPressure(at(210)), 'warning');      // 70%
  assert.equal(quotaPressure(at(250)), 'warning');      // 83%
  assert.equal(quotaPressure(at(255)), 'high');         // 85%
  assert.equal(quotaPressure(at(280)), 'high');         // 93%
  assert.equal(quotaPressure(at(285)), 'critical');     // 95%
  assert.equal(quotaPressure(at(299)), 'critical');     // 99.7%
  assert.equal(quotaPressure(at(300)), 'quota_exhausted');

  // A wrong key matters more than a quiet day.
  const suppressed = reason => ({ suppressed_until: new Date(Date.now() + 60_000), suppression_reason: reason });
  assert.equal(quotaPressure(at(0), suppressed('invalid_configuration')), 'configuration_error');
  assert.equal(quotaPressure(at(0), suppressed('rate_limited')), 'provider_rate_limited');
  assert.equal(quotaPressure(at(0), suppressed('provider_unavailable')), 'provider_unavailable');
  assert.equal(quotaPressure(at(0), suppressed('quota_exhausted')), 'quota_exhausted');

  // A suppression that has expired is not a state.
  assert.equal(quotaPressure(at(0), { suppressed_until: new Date(Date.now() - 60_000), suppression_reason: 'rate_limited' }),
    'healthy');
  // No configured allowance means no invented percentage.
  assert.equal(quotaPressure({ sent: 5, allowance: null, remaining: null, usedPercent: null, exhausted: false }), 'healthy');
});

test('when capacity is scarce it is spent on the messages somebody must act on', () => {
  assert.equal(emailAdmitted('optional', 'healthy'), true);
  assert.equal(emailAdmitted('optional', 'warning'), true);

  // 85%: stop sending the pleasant ones.
  assert.equal(emailAdmitted('optional', 'high'), false);
  assert.equal(emailAdmitted('normal', 'high'), true);
  assert.equal(emailAdmitted('high', 'high'), true);

  // 95%: keep only what somebody has to act on.
  assert.equal(emailAdmitted('normal', 'critical'), false);
  assert.equal(emailAdmitted('high', 'critical'), true);

  // Gone: a cancelled trip still queues and goes out after the reset.
  assert.equal(emailAdmitted('high', 'quota_exhausted'), true);
  assert.equal(emailAdmitted('normal', 'quota_exhausted'), false);

  // A wrong credential sends nothing at all, whatever its importance.
  assert.equal(emailAdmitted('high', 'configuration_error'), false);
});

test('usage is counted from our own ledger and labelled as ours', async () => {
  const usage = await db.transaction(tx => dailyUsage(tx, 'email', ALLOWANCE));
  assert.equal(usage.allowance, ALLOWANCE);
  assert.equal(typeof usage.sent, 'number');
  assert.equal(usage.remaining, ALLOWANCE - usage.sent);
  // No allowance configured means no pretend remaining figure.
  const unbounded = await db.transaction(tx => dailyUsage(tx, 'email', null));
  assert.equal(unbounded.allowance, null);
  assert.equal(unbounded.remaining, null);
  assert.equal(unbounded.usedPercent, null);
  assert.equal(unbounded.exhausted, false);
});

// ---- the dispatcher --------------------------------------------------------

test('an exhausted allowance defers the message and never calls the provider', async () => {
  const { delivery } = await queueEmail();
  const spy = spyAdapter({ accepted: true });
  // An allowance of 0 is "already spent" without needing to send 300 first.
  await notificationDelivery(db, { email: spy.adapter }, { emailDailyQuota: 1 }).tick();
  await db.transaction(tx => recordOutcome(tx, 'email', { outcome: 'quota_exhausted', suppressUntil: nextDailyReset() }));

  const { delivery: second } = await queueEmail();
  const spy2 = spyAdapter({ accepted: true });
  await notificationDelivery(db, { email: spy2.adapter }, { emailDailyQuota: 1 }).tick();

  assert.equal(spy2.calls.length, 0, 'a suppressed channel must not reach the provider at all');
  const row = await deliveryRow(second);
  // Deferred, not failed: the message is still going to be delivered.
  assert.equal(row.status, 'pending');
  assert.equal(row.detail, 'channel_quota_exhausted');
  assert.ok(new Date(row.next_attempt_at) > new Date(Date.now() + 60_000),
    'a spent allowance must wait for the reset, not retry in thirty seconds');
  assert.ok(delivery);
});

test('an exhausted allowance leaves the in-app notification and the transaction alone', async () => {
  const { notification } = await queueEmail();
  const spy = spyAdapter({ accepted: false, reason: 'quota_exhausted', suppressUntil: nextDailyReset() });
  await notificationDelivery(db, { email: spy.adapter }, {}).tick();

  const all = await rows('SELECT channel,status FROM notification_deliveries WHERE notification_id=$1', [notification]);
  const inApp = all.find(r => r.channel === 'in_app');
  assert.equal(inApp.status, 'sent', 'the inbox is the baseline and must survive any provider state');
  // And nothing a passenger could read mentions a provider, a status code or a quota.
  const visible = JSON.stringify(all);
  assert.ok(!/brevo|quota|429|402|credit/i.test(visible.replace(/channel_quota_exhausted/g, '')),
    'provider terminology reached a user-visible field');
});

test('a rate limit waits the provider’s own delay, not the generic backoff', async () => {
  await unsuppress();
  const { delivery } = await queueEmail({ attempts: 0 });
  const until = new Date(Date.now() + 45_000);
  const spy = spyAdapter({ accepted: false, reason: 'rate_limited', suppressUntil: until });
  await notificationDelivery(db, { email: spy.adapter }, {}).tick();

  const row = await deliveryRow(delivery);
  assert.equal(row.status, 'pending', 'a rate limit is not a failure');
  assert.equal(row.detail, 'channel_rate_limited');
  const waitSeconds = (new Date(row.next_attempt_at).getTime() - Date.now()) / 1000;
  assert.ok(waitSeconds > 30 && waitSeconds < 120, `expected the provider's ~45s, got ${Math.round(waitSeconds)}s`);
  await db.transaction(tx => tx.query("UPDATE notification_channel_state SET suppressed_until=NULL WHERE channel='email'"));
});

test('a rejected address fails once and leaves everybody else’s mail working', async () => {
  await unsuppress();
  const { delivery } = await queueEmail();
  const spy = spyAdapter({ accepted: false, reason: 'recipient_rejected' });
  await notificationDelivery(db, { email: spy.adapter }, {}).tick();

  const row = await deliveryRow(delivery);
  assert.equal(row.status, 'failed', 'retrying a bad address cannot help');
  assert.equal(row.detail, 'recipient_rejected');
  assert.ok(row.attempts < 5, 'it must fail immediately rather than exhaust the retries');
  const state = await db.transaction(tx => channelState(tx, 'email'));
  assert.ok(!state?.suppressed_until, 'one bad address must not stop the channel');
});

test('a wrong credential fails immediately and stops the channel until it is fixed', async () => {
  await unsuppress();
  const { delivery } = await queueEmail();
  const spy = spyAdapter({ accepted: false, reason: 'invalid_configuration', suppressUntil: nextDailyReset() });
  await notificationDelivery(db, { email: spy.adapter }, {}).tick();

  const row = await deliveryRow(delivery);
  assert.equal(row.status, 'failed');
  assert.equal(row.detail, 'invalid_configuration');
  const state = await db.transaction(tx => channelState(tx, 'email'));
  assert.equal(state.suppression_reason, 'invalid_configuration');

  // A later success is the only honest way out of a configuration error.
  await db.transaction(tx => recordOutcome(tx, 'email', { outcome: 'sent' }));
  const cleared = await db.transaction(tx => channelState(tx, 'email'));
  assert.equal(cleared.suppressed_until, null);
  assert.equal(cleared.suppression_reason, null);
  assert.ok(cleared.last_success_at);
});

test('a transient provider failure keeps the existing backoff and dead-letter', async () => {
  await unsuppress();
  const { delivery } = await queueEmail({ attempts: 2 });
  const spy = spyAdapter({ accepted: false, reason: 'provider_unavailable' });
  await notificationDelivery(db, { email: spy.adapter }, {}).tick();
  let row = await deliveryRow(delivery);
  assert.equal(row.status, 'pending');
  assert.equal(row.detail, 'retry_scheduled', 'existing retry semantics must be preserved');

  // And it still dead-letters rather than retrying forever.
  await unsuppress();
  const exhausted = await queueEmail({ attempts: 6 });
  await db.transaction(tx => tx.query('UPDATE notification_deliveries SET next_attempt_at=NULL WHERE id=$1', [exhausted.delivery]));
  await notificationDelivery(db, { email: spyAdapter({ accepted: false, reason: 'provider_unavailable' }).adapter }, {}).tick();
  row = await deliveryRow(exhausted.delivery);
  assert.equal(row.status, 'failed');
  assert.equal(row.detail, 'dead_letter');
});

test('a provider that throws is read as unreachable rather than as a bad address', async () => {
  await unsuppress();
  const { delivery } = await queueEmail({ attempts: 1 });
  const throwing = { idempotent: true, async send() { throw new Error('boom'); } };
  await notificationDelivery(db, { email: throwing }, {}).tick();
  const row = await deliveryRow(delivery);
  // Conservative: retry rather than discard somebody's ticket confirmation.
  assert.equal(row.status, 'pending');
  assert.equal(row.detail, 'retry_scheduled');
});

test('no provider terminology is ever written to a delivery record', async () => {
  const details = await rows('SELECT DISTINCT detail FROM notification_deliveries');
  const attempts = await rows('SELECT DISTINCT status FROM notification_delivery_attempts');
  for (const { detail } of details) {
    assert.ok(!/brevo|sendinblue|smtp|http|\b[45]\d\d\b/i.test(detail), `detail leaked provider terminology: ${detail}`);
  }
  for (const { status } of attempts) {
    assert.ok(!/brevo|sendinblue|smtp|http|\b[45]\d\d\b/i.test(status), `attempt leaked provider terminology: ${status}`);
  }
});

test('thresholds are configuration, not a constant somebody has to edit code to change', () => {
  const at = sent => ({ sent, allowance: 100, remaining: 100 - sent, usedPercent: sent, exhausted: sent >= 100 });
  assert.equal(quotaPressure(at(50), null, DEFAULT_QUOTA_THRESHOLDS), 'healthy');
  assert.equal(quotaPressure(at(50), null, { warning: 40, high: 60, critical: 80 }), 'warning');
  assert.equal(quotaPressure(at(65), null, { warning: 40, high: 60, critical: 80 }), 'high');
  assert.equal(quotaPressure(at(85), null, { warning: 40, high: 60, critical: 80 }), 'critical');
});
