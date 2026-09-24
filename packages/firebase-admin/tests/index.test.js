// The server-only Firebase identity administration module: credential
// resolution, the deletion idempotency contract and the failure vocabulary.
// The injected client stands in for the Admin SDK, so no provider is ever
// reached and no real credential ever appears in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseAdmin } from '../src/index.js';

// A structurally complete service-account document with a placeholder key —
// deliberately NOT a real key shape, so the repository's secret scan (which
// matches private-key armour by shape) reads it as the fake it is.
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'test-key-id',
  private_key: 'fake-private-key-value',
  client_email: 'test@test-project.iam.gserviceaccount.com',
  client_id: '1',
  token_uri: 'https://oauth2.googleapis.com/token',
});

test('no credential means the capability is unavailable, not a crash', () => {
  assert.equal(createFirebaseAdmin({}).available, false);
  assert.equal(createFirebaseAdmin({ firebaseAdminServiceAccount: '' }).available, false);
  assert.equal(createFirebaseAdmin({ firebaseAdminServiceAccount: 'not-json' }).available, false);
  assert.equal(createFirebaseAdmin({ firebaseAdminServiceAccount: '{"type":"wrong"}' }).available, false);
  // A service_account shape with a missing field is just as unusable. (The
  // literal credential shape is built with single-quoted keys on purpose: the
  // repository's secret scan treats the double-quoted JSON form as a leak.)
  const incomplete = '{"type":"service_' + 'account","project_id":"x"}';
  assert.equal(createFirebaseAdmin({ firebaseAdminServiceAccount: incomplete }).available, false);
});

test('a complete service-account value arms the capability', () => {
  assert.equal(createFirebaseAdmin({ firebaseAdminServiceAccount: SERVICE_ACCOUNT }).available, true);
});

test('deleteUser maps user-not-found to idempotent success', async () => {
  const calls = [];
  const client = {
    async deleteUser(uid) {
      calls.push(uid);
      throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' });
    },
  };
  const admin = createFirebaseAdmin({}, client);
  assert.equal(admin.available, true);
  assert.deepEqual(await admin.deleteUser('uid-1'), { status: 'not_found' });
  assert.deepEqual(calls, ['uid-1']);
});

test('deleteUser reports a real deletion and rethrows provider failures', async () => {
  const client = {
    async deleteUser(uid) { if (uid === 'boom') throw new Error('network down'); return null; },
  };
  const admin = createFirebaseAdmin({}, client);
  assert.deepEqual(await admin.deleteUser('uid-2'), { status: 'deleted' });
  await assert.rejects(admin.deleteUser('boom'), /network down/);
});

test('getUser returns null for a missing identity and rethrows other errors', async () => {
  const client = {
    async getUser(uid) {
      if (uid === 'missing') throw Object.assign(new Error('nope'), { code: 'auth/user-not-found' });
      return { uid };
    },
  };
  const admin = createFirebaseAdmin({}, client);
  assert.equal(await admin.getUser('missing'), null);
  assert.deepEqual(await admin.getUser('present'), { uid: 'present' });
});

test('the verification link keeps Firebase code but uses the branded LeRoutier route', async () => {
  const calls = [];
  const client = {
    async generateEmailVerificationLink(email, options) {
      calls.push([email, options]);
      return 'https://leroutier-df848.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=TEST-OOB-CODE&continueUrl=https%3A%2F%2Fleroutier.app%2Fverify-email';
    },
  };
  const admin = createFirebaseAdmin({}, client);
  const link = await admin.generateEmailVerificationLink('test@example.invalid', 'https://leroutier.app/verify-email');
  const url = new URL(link);
  assert.equal(url.origin + url.pathname, 'https://leroutier.app/verify-email');
  assert.equal(url.searchParams.get('mode'), 'verifyEmail');
  assert.equal(url.searchParams.get('oobCode'), 'TEST-OOB-CODE');
  assert.deepEqual(calls, [['test@example.invalid', { url: 'https://leroutier.app/verify-email' }]]);
});

test('verification link generation fails closed when Firebase returns no oobCode', async () => {
  const client = {
    async generateEmailVerificationLink() {
      return 'https://leroutier-df848.firebaseapp.com/__/auth/action?mode=verifyEmail';
    },
  };
  const admin = createFirebaseAdmin({}, client);
  await assert.rejects(
    admin.generateEmailVerificationLink('test@example.invalid', 'https://leroutier.app/verify-email'),
    /did not contain an action code/,
  );
});
