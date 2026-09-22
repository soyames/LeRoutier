// What a member of LeRoutier's own staff may do.
//
// The property under test is not "the console hides a menu item". It is that a
// person holding one authorization cannot obtain, through any endpoint, data
// belonging to another — most sharply that somebody granted `finance` never
// receives the KYC queue, which carries national identity references, driving
// licence numbers and driver photographs.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { provisioning, bootstrap } from '../src/provisioning.js';
import { activeIdentity } from '../src/identities.js';
import { operationalHealth } from '../src/operational-health.js';
import { onboarding } from '../src/onboarding.js';
import { privacyCenter } from '../src/privacy.js';
import { PLATFORM_CAPABILITIES, GRANTABLE, normaliseCapabilities } from '../src/platform-access.js';
import { serverConfig } from '@leroutier/config';
import { jwtFixture } from '../../../services/api/tests/jwt-fixture.js';

const db = createDatabase({ ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', '') });
const actor = id => db.transaction(tx => activeIdentity(tx, id));
let fixture, provision, health, onboard, priv, superadmin, operatorA;

/** A platform identity holding exactly `capabilities`, created by the superadmin. */
async function staffMember(name, capabilities) {
  const created = await provision.platformUser(superadmin,
    { subject: 'staff-' + name, displayName: 'Staff ' + name, capabilities }, randomUUID());
  return actor(created.id);
}

before(async () => {
  await migrate(db);
  fixture = await jwtFixture();
  provision = provisioning(db, fixture.config);
  health = operationalHealth(db);
  onboard = onboarding(db);
  priv = privacyCenter(db);
  const initial = await bootstrap(db, {
    operatorKey: 'access-alpha', operatorName: 'Access Alpha', opsSubject: 'access-platform',
    opsName: 'Access Platform', issuer: fixture.config.issuer, platformOps: true,
  });
  operatorA = initial.operatorId;
  superadmin = await actor(initial.opsUserId);
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('the bootstrapped identity is the superadmin, and holds every capability', async () => {
  assert.ok(superadmin.platform_capabilities.includes('superadmin'));
  for (const capability of PLATFORM_CAPABILITIES) {
    assert.ok(superadmin.platform_capabilities.includes(capability), `superadmin must imply ${capability}`);
  }
});

test('a second superadmin is impossible, and the database is what refuses it', async () => {
  const other = await staffMember('rival', ['users']);
  // Not through the console: superadmin is not a grantable capability at all.
  assert.throws(() => normaliseCapabilities(['superadmin']), { code: 'INVALID_INPUT' });
  await assert.rejects(
    provision.platformGrants(superadmin, other.id, { capabilities: ['superadmin'] }, randomUUID()),
    { code: 'INVALID_INPUT' });
  // And not by going round it either: the unique index is the actual guarantee.
  await assert.rejects(db.transaction(tx =>
    tx.query("INSERT INTO platform_grants(user_id,capability) VALUES($1,'superadmin')", [other.id])));
  const { rows } = await db.transaction(tx =>
    tx.query("SELECT count(*)::int AS n FROM platform_grants WHERE capability='superadmin'"));
  assert.equal(rows[0].n, 1);
});

test('a platform identity with no authorizations can sign in and reach nothing', async () => {
  const nobody = await staffMember('nobody', []);
  assert.deepEqual(nobody.platform_capabilities, []);
  await assert.rejects(health.read(nobody), { code: 'FORBIDDEN' });
  await assert.rejects(health.users(nobody, {}), { code: 'FORBIDDEN' });
  await assert.rejects(onboard.listOperators(nobody), { code: 'FORBIDDEN' });
  await assert.rejects(priv.createHold(nobody, { subjectKind: 'user', subjectId: randomUUID(), reason: 'x' }),
    { code: 'FORBIDDEN' });
});

test('one authorization does not open another', async () => {
  const reviewer = await staffMember('reviewer', ['verification']);
  const accountant = await staffMember('accountant', ['finance']);

  // The reviewer does their own job.
  assert.ok(Array.isArray(await onboard.listOperators(reviewer)));
  // And not anybody else's.
  await assert.rejects(health.users(reviewer, {}), { code: 'FORBIDDEN' });
  await assert.rejects(priv.createHold(reviewer, { subjectKind: 'user', subjectId: randomUUID(), reason: 'x' }),
    { code: 'FORBIDDEN' });
  await assert.rejects(provision.operator(reviewer, { key: 'nope', name: 'Nope' }, randomUUID()),
    { code: 'FORBIDDEN' });

  // The accountant cannot open a dossier, which is the point of the split.
  await assert.rejects(onboard.listOperators(accountant), { code: 'FORBIDDEN' });
});

test('the platform dashboard never ships a section the caller may not see', async () => {
  const accountant = await staffMember('finance-only', ['finance']);
  const reviewer = await staffMember('kyc-only', ['verification']);

  const forAccountant = await health.read(accountant);
  // THE load-bearing assertion: the KYC queue carries identity documents, and
  // a finance grant must not deliver them. A console that declines to draw
  // them is not the same as a payload that does not contain them.
  assert.deepEqual(forAccountant.kycQueue, [], 'finance must not receive the KYC dossier queue');
  assert.equal(forAccountant.storage, null, 'capacity belongs to system');
  assert.equal(forAccountant.migrations, null);
  assert.deepEqual(forAccountant.incidents, []);
  assert.ok(Array.isArray(forAccountant.paymentAnomalies));
  assert.equal(forAccountant.counts.kyc_pending, undefined, 'counts are filtered too');
  assert.notEqual(forAccountant.counts.payments_failed_total, undefined);

  const forReviewer = await health.read(reviewer);
  assert.deepEqual(forReviewer.paymentAnomalies, []);
  assert.deepEqual(forReviewer.payoutAnomalies, []);
  assert.equal(forReviewer.counts.payments_failed_total, undefined);
  assert.notEqual(forReviewer.counts.kyc_pending, undefined);

  // The superadmin sees the lot, so the filtering is not simply omitting.
  const everything = await health.read(superadmin);
  assert.ok(everything.migrations);
  assert.ok(everything.storage);
  assert.notEqual(everything.counts.kyc_pending, undefined);
  assert.notEqual(everything.counts.payments_failed_total, undefined);
});

test('revoking an authorization takes effect on the next request, not the next sign-in', async () => {
  const member = await staffMember('revoked', ['users']);
  assert.ok(Array.isArray((await health.users(member, {})).users));

  await provision.platformGrants(superadmin, member.id, { capabilities: [] }, randomUUID());
  // Re-resolving the identity is what every authenticated request does.
  const after = await actor(member.id);
  assert.deepEqual(after.platform_capabilities, []);
  await assert.rejects(health.users(after, {}), { code: 'FORBIDDEN' });
});

test('only the superadmin manages the team, and never their own authorizations', async () => {
  const provisioner = await staffMember('provisioner', ['provisioning']);
  const target = await staffMember('target', ['incidents']);

  // Holding `provisioning` shows the team but does not change it: creating
  // platform staff is the single seat's decision, not a delegated one.
  assert.ok(Array.isArray(await provision.platformTeam(provisioner)));
  await assert.rejects(
    provision.platformGrants(provisioner, target.id, { capabilities: ['finance'] }, randomUUID()),
    { code: 'FORBIDDEN' });
  await assert.rejects(
    provision.platformUser(provisioner, { subject: 'sneaky', displayName: 'Sneaky', capabilities: ['finance'] }, randomUUID()),
    { code: 'FORBIDDEN' });

  // Nobody edits their own privileges, including the superadmin.
  await assert.rejects(
    provision.platformGrants(superadmin, superadmin.id, { capabilities: ['users'] }, randomUUID()),
    { code: 'FORBIDDEN' });

  // The superadmin can, and the change is visible immediately.
  await provision.platformGrants(superadmin, target.id, { capabilities: ['finance', 'incidents'] }, randomUUID());
  assert.deepEqual((await actor(target.id)).platform_capabilities.sort(), ['finance', 'incidents']);
});

test('an operator account is never a platform account, whatever rows exist', async () => {
  const companyOps = await provision.opsUser(superadmin,
    { subject: 'company-ops-access', displayName: 'Company Ops', operatorId: operatorA }, randomUUID());
  const resolved = await actor(companyOps.id);
  assert.equal(resolved.operator_id, operatorA);
  assert.deepEqual(resolved.platform_capabilities, [], 'operator staff hold no platform capability');

  // Even a grant row attached to an operator account grants nothing: the
  // capability resolver refuses to treat it as platform staff at all.
  await db.transaction(tx =>
    tx.query("INSERT INTO platform_grants(user_id,capability) VALUES($1,'verification')", [companyOps.id]));
  assert.deepEqual((await actor(companyOps.id)).platform_capabilities, []);
  await assert.rejects(onboard.listOperators(await actor(companyOps.id)), { code: 'FORBIDDEN' });

  // And that account cannot be widened into the platform by provisioning.
  await assert.rejects(
    provision.platformUser(superadmin,
      { subject: 'company-ops-access', displayName: 'Company Ops', capabilities: ['finance'] }, randomUUID()),
    { code: 'FORBIDDEN' });
});

test('an unknown authorization is refused rather than ignored', async () => {
  const member = await staffMember('unknown-cap', ['users']);
  for (const bad of [['not-a-capability'], ['users', 'root'], 'users', [{}]]) {
    await assert.rejects(
      provision.platformGrants(superadmin, member.id, { capabilities: bad }, randomUUID()),
      { code: 'INVALID_INPUT' }, `must refuse ${JSON.stringify(bad)}`);
  }
  // Unchanged: a refused request grants nothing and removes nothing.
  assert.deepEqual((await actor(member.id)).platform_capabilities, ['users']);
});

test('the grantable set and the database constraint agree', async () => {
  const { rows } = await db.transaction(tx => tx.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid='platform_grants'::regclass AND contype='c'`));
  const definition = rows.map(r => r.def).join(' ');
  for (const capability of GRANTABLE) {
    assert.ok(definition.includes(`'${capability}'`),
      `${capability} is grantable in code but not allowed by the database`);
  }
});
