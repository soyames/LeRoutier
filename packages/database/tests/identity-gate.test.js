// The verified-email gate on identity mapping.
//
// A password identity whose address has not been confirmed must not become a
// LeRoutier account: mapIdentity is the single door between a verified
// Firebase token and a users row, and this suite pins what passes through it —
// and what does not — for every identity kind the platform recognizes.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { mapIdentity } from '../src/identities.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
const ISSUER = 'https://issuer.test.invalid';

const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));

before(async () => { await migrate(db); await seed(db); });
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('an unverified password identity is refused and creates nothing', async () => {
  const subject = 'unverified-' + randomUUID();
  await assert.rejects(mapIdentity(db, { subject, issuer: ISSUER, signInProvider: 'password', emailVerified: false }),
    /** @param {any} error */ error => {
      assert.equal(error.code, 'EMAIL_NOT_VERIFIED');
      assert.equal(error.status, 403);
      return true;
    });
  assert.equal((await one('SELECT count(*)::integer AS n FROM users WHERE auth_subject=$1', [subject])).n, 0,
    'a refused identity must leave no row behind');
});

test('a verified password identity is established normally', async () => {
  const subject = 'verified-' + randomUUID();
  const user = await mapIdentity(db, { subject, issuer: ISSUER, signInProvider: 'password', emailVerified: true, notificationEmail: 'passenger@example.invalid' });
  assert.equal(user.role, 'passenger');
  assert.equal((await one('SELECT notification_email FROM users WHERE auth_subject=$1', [subject])).notification_email, 'passenger@example.invalid');
});

test('a Google identity is not gated: the provider verifies its own addresses', async () => {
  const subject = 'google-' + randomUUID();
  const user = await mapIdentity(db, { subject, issuer: ISSUER, signInProvider: 'google.com', emailVerified: false });
  assert.equal(user.role, 'passenger');
});

test('identities without a provider claim (custom tokens, legacy calls) are not gated', async () => {
  // Custom-token identities are provisioned through reviewed paths, and
  // existing callers that pass no claims must keep working: the gate applies
  // exactly when a password provider is positively identified.
  const subject = 'custom-' + randomUUID();
  const user = await mapIdentity(db, { subject, issuer: ISSUER });
  assert.equal(user.role, 'passenger');
  const also = await mapIdentity(db, { subject, issuer: ISSUER, signInProvider: 'custom', emailVerified: false });
  assert.equal(also.id, user.id);
});
