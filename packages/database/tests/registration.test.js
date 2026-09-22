// Registration capacity protection, end to end.
//
// The point of this suite is the distinction the product depends on:
// registration closing must stop NEW accounts and nothing else. An existing
// passenger must still be able to sign in, hold a booking, pay and be issued
// a ticket while the door is shut behind them.
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { mapIdentity } from '../src/identities.js';
import { registrationCapacity, registrationPolicy } from '../src/registration.js';
import { transport } from '../src/transport.js';
import { operationalHealth } from '../src/operational-health.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
const domain = transport(db);
const health = operationalHealth(db);
const ISSUER = 'https://issuer.test.invalid';

// The environment is the policy, so each case states the environment it means
// and restores it afterwards rather than leaking into the next test.
const ENV_KEYS = ['REGISTRATION_ENABLED', 'DATABASE_STORAGE_LIMIT_MB', 'REGISTRATION_STORAGE_STOP_PERCENT'];
let saved;
function env(values) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));

before(async () => {
  await migrate(db);
  await seed(db);
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
});
beforeEach(() => { env({}); });
after(async () => {
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  try { await dropDisposableSchema(db); } finally { await db.close(); }
});

test('the policy ignores values that would silently disable the protection', () => {
  assert.equal(registrationPolicy({}).threshold, 85, 'the default stop threshold is 85%');
  assert.equal(registrationPolicy({}).registrationEnabled, true);
  assert.equal(registrationPolicy({ REGISTRATION_STORAGE_STOP_PERCENT: '1' }).threshold, 85, 'an absurd low threshold is ignored');
  assert.equal(registrationPolicy({ REGISTRATION_STORAGE_STOP_PERCENT: '140' }).threshold, 85, 'an absurd high threshold is ignored');
  assert.equal(registrationPolicy({ REGISTRATION_STORAGE_STOP_PERCENT: 'nope' }).threshold, 85);
  assert.equal(registrationPolicy({ REGISTRATION_STORAGE_STOP_PERCENT: '70' }).threshold, 70, 'a sane threshold is honoured');
  assert.equal(registrationPolicy({ DATABASE_STORAGE_LIMIT_MB: '0' }).limitBytes, null, 'a zero limit is no limit, not a closed door');
  assert.equal(registrationPolicy({ DATABASE_STORAGE_LIMIT_MB: '512' }).limitBytes, 512 * 1024 * 1024);
  // Only the exact string closes the door: a typo must not take the platform
  // offline, because the storage threshold is the real protection.
  assert.equal(registrationPolicy({ REGISTRATION_ENABLED: 'FALSE' }).registrationEnabled, true);
  assert.equal(registrationPolicy({ REGISTRATION_ENABLED: 'false' }).registrationEnabled, false);
});

test('with no limit configured, registration stays open and provisions an identity', async () => {
  const subject = 'open-' + randomUUID();
  const user = await mapIdentity(db, { subject, issuer: ISSUER });
  assert.equal(user.role, 'passenger');
  assert.equal((await one('SELECT count(*)::integer AS n FROM users WHERE auth_subject=$1', [subject])).n, 1);
});

test('the kill switch refuses a new identity and creates nothing', async () => {
  env({ REGISTRATION_ENABLED: 'false' });
  const subject = 'disabled-' + randomUUID();
  await assert.rejects(mapIdentity(db, { subject, issuer: ISSUER }), /** @param {any} error */ error => {
    assert.equal(error.code, 'REGISTRATION_SUSPENDED');
    assert.equal(error.status, 503, 'a paused door is temporary, not a client error');
    // The refusal is opaque: a visitor never learns how full the database is.
    assert.ok(!/\d+\s*%|byte|octet|storage|pg_database|quota|neon/i.test(error.message),
      'the refusal must not disclose capacity details: ' + error.message);
    return true;
  });
  assert.equal((await one('SELECT count(*)::integer AS n FROM users WHERE auth_subject=$1', [subject])).n, 0,
    'a refused registration must leave no row behind');
});

test('an existing identity still signs in while registration is closed', async () => {
  const subject = 'existing-' + randomUUID();
  const created = await mapIdentity(db, { subject, issuer: ISSUER });
  env({ REGISTRATION_ENABLED: 'false' });
  const again = await mapIdentity(db, { subject, issuer: ISSUER });
  assert.equal(again.id, created.id, 'capacity never locks anybody out of an account they already have');
  // And with the storage threshold tripped rather than the kill switch.
  env({ DATABASE_STORAGE_LIMIT_MB: '1', REGISTRATION_STORAGE_STOP_PERCENT: '50' });
  const third = await mapIdentity(db, { subject, issuer: ISSUER });
  assert.equal(third.id, created.id);
});

test('crossing the storage threshold closes registration; staying under it does not', async () => {
  // 1 MB limit against a database that is certainly larger: over threshold.
  env({ DATABASE_STORAGE_LIMIT_MB: '1', REGISTRATION_STORAGE_STOP_PERCENT: '85' });
  const overCapacity = await db.transaction(tx => registrationCapacity(tx));
  assert.equal(overCapacity.registrationsOpen, false);
  assert.equal(overCapacity.reason, 'storage');
  assert.ok(overCapacity.usedPercent > 85);
  await assert.rejects(mapIdentity(db, { subject: 'full-' + randomUUID(), issuer: ISSUER }), { code: 'REGISTRATION_SUSPENDED' });

  // A limit far above the real size: comfortably under threshold, door open.
  env({ DATABASE_STORAGE_LIMIT_MB: String(1024 * 1024), REGISTRATION_STORAGE_STOP_PERCENT: '85' });
  const under = await db.transaction(tx => registrationCapacity(tx));
  assert.equal(under.registrationsOpen, true);
  assert.equal(under.reason, null);
  const subject = 'room-' + randomUUID();
  await mapIdentity(db, { subject, issuer: ISSUER });
  assert.equal((await one('SELECT count(*)::integer AS n FROM users WHERE auth_subject=$1', [subject])).n, 1);
});

test('concurrent first sign-ins cannot slip past a closed door', async () => {
  env({ DATABASE_STORAGE_LIMIT_MB: '1', REGISTRATION_STORAGE_STOP_PERCENT: '60' });
  const subjects = Array.from({ length: 8 }, () => 'burst-' + randomUUID());
  const results = await Promise.allSettled(subjects.map(subject => mapIdentity(db, { subject, issuer: ISSUER })));
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'REGISTRATION_SUSPENDED'),
    'every concurrent attempt is refused, not just the first');
  const created = await one('SELECT count(*)::integer AS n FROM users WHERE auth_subject = ANY($1)', [subjects]);
  assert.equal(created.n, 0, 'the advisory lock must leave no partially-admitted burst behind');
});

test('a closed door does not stop travelling: existing passengers still book', async () => {
  // A real identity, created while the door was open.
  const subject = 'traveller-' + randomUUID();
  const passenger = await mapIdentity(db, { subject, issuer: ISSUER });
  await db.transaction(async tx => {
    await tx.query("UPDATE users SET display_name='Voyageur Existant',profile_completed_at=now() WHERE id=$1", [passenger.id]);
  });
  // Now close registration entirely.
  env({ REGISTRATION_ENABLED: 'false', DATABASE_STORAGE_LIMIT_MB: '1', REGISTRATION_STORAGE_STOP_PERCENT: '50' });
  const actor = await mapIdentity(db, { subject, issuer: ISSUER });
  assert.equal(actor.id, passenger.id);

  // Search still answers, and a seat can still be held and confirmed.
  const services = await domain.search({ includeDemo: true });
  assert.ok(services.length > 0, 'search keeps working while registration is closed');
  const booking = await domain.hold({ ...actor, role: 'passenger' },
    { serviceId: demo.service, origin: 0, destination: 1 }, randomUUID());
  assert.equal(booking.status, 'held');
  assert.ok(booking.amount_minor > 0);
});

test('capacity detail is Platform Ops information, and Company Ops cannot read it', async () => {
  env({ DATABASE_STORAGE_LIMIT_MB: '4096', REGISTRATION_STORAGE_STOP_PERCENT: '85' });
  const platform = { id: demo.ops, role: 'ops', operator_id: null };
  const report = await health.read(platform);
  assert.equal(typeof report.storage.usedBytes, 'number');
  assert.equal(report.storage.registrationStopPercent, 85);
  assert.equal(typeof report.storage.registrationsOpen, 'boolean');
  // The same numbers the gate enforces, not a second measurement.
  const measured = await db.transaction(tx => registrationCapacity(tx));
  assert.equal(report.storage.registrationStopPercent, measured.registrationStopPercent);
  assert.equal(report.storage.registrationsOpen, measured.registrationsOpen);
  await assert.rejects(health.read({ id: demo.ops, role: 'ops', operator_id: demo.operator }), { code: 'FORBIDDEN' });
  await assert.rejects(health.read({ id: demo.passenger, role: 'passenger' }), { code: 'FORBIDDEN' });
});

test('an unconfigured storage limit is reported as an unarmed protection, not as capacity', async () => {
  // The failure this closes: with no DATABASE_STORAGE_LIMIT_MB there is nothing
  // to measure against, so registrationsOpen is true for the same reason an
  // unplugged smoke alarm is silent. Platform Ops rendered that as a green
  // "capacity available" — the one screen meant to warn about it agreeing that
  // everything was fine.
  env({});
  const unarmed = await db.transaction(tx => registrationCapacity(tx));
  assert.equal(unarmed.storageProtection, 'not_configured');
  assert.equal(unarmed.registrationsOpen, true, 'and it still fails open, which is the right default');
  assert.equal(unarmed.limitBytes, null);

  env({ DATABASE_STORAGE_LIMIT_MB: '4096' });
  const armed = await db.transaction(tx => registrationCapacity(tx));
  assert.equal(armed.storageProtection, 'armed');
  assert.equal(typeof armed.usedPercent, 'number', 'an armed protection reports a real percentage');

  // A manual close is still a closed door, but it is not the storage gate and
  // must not be reported as one.
  env({ REGISTRATION_ENABLED: 'false' });
  const disabled = await db.transaction(tx => registrationCapacity(tx));
  assert.equal(disabled.storageProtection, 'not_configured');
  assert.equal(disabled.registrationsOpen, false);
  assert.equal(disabled.reason, 'disabled');
});

test('Platform Ops health carries the armed state, so a console cannot infer it from a null', async () => {
  env({});
  const ops = { id: demo.platformOps ?? demo.ops, role: 'ops', operator_id: null };
  const view = await health.read(ops);
  assert.equal(view.storage.storageProtection, 'not_configured');
  // And the public never learns any of it.
  assert.ok(!JSON.stringify(view.storage).includes('DATABASE_URL'));
});
