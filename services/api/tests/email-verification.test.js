// The account-verification email endpoint, end to end with a real database:
// the token's claims — never a body field — are the address, password
// identities only, an idempotent already-verified answer, a resend ceiling,
// and a Brevo failure that stays retryable without ever leaking the action
// code. Brevo is a recorded fetch, the Admin SDK is an injected double.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { seed } from '@leroutier/database/seed';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { createApi } from '../src/app.js';
import { jwtFixture } from './jwt-fixture.js';

const base = serverConfig();
const config = { ...base, schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true,
  notificationProviders: { ...base.notificationProviders, emailProvider: 'brevo',
    brevo: { apiKey: 'test-brevo-key', fromAddress: 'noreply@leroutier.app', fromName: 'LeRoutier' } },
  // Stands in for the whole createFirebaseAdmin wrapper: (email, continueUrl).
  firebaseAdmin: { available: true, generateEmailVerificationLink: async (email, continueUrl) => `${continueUrl}?oobCode=TEST-OOB-CODE` } };
const db = createDatabase(config);

let fixture, api, brevoCalls;
function fakeBrevo(status, body = {}) {
  return async (url, init) => {
    brevoCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(status === 201 ? JSON.stringify({ messageId: '<20260101.test@brevo>' }) : JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json', 'x-sib-ratelimit-remaining': '90', 'x-sib-ratelimit-reset': '60' } });
  };
}
const call = (path, opts = {}) => { const { method = 'POST', token = null, body } = opts;
  return api(new Request('http://localhost/api/v1' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })); };
const passwordToken = async (uid, { verified = false } = {}) => fixture.sign(uid, {
  email: uid + '@example.invalid', email_verified: verified, firebase: { sign_in_provider: 'password' } });

before(async () => {
  await migrate(db); await seed(db);
  fixture = await jwtFixture();
  // The verifier derives issuer/audience from FIREBASE_PROJECT_ID in real
  // deployments; the fixture supplies its own key set, so pin the same
  // derived values it signs with.
  Object.assign(config, { issuer: fixture.config.issuer, audience: fixture.config.audience, jwksUrl: fixture.config.jwksUrl });
  brevoCalls = [];
  api = createApi(db, config, fixture.resolver, undefined, fakeBrevo(201));
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('a valid unverified password token produces exactly one Brevo send, addressed from the token claims', async () => {
  const uid = 'verify-' + randomUUID();
  const r = await call('/auth/email-verification', { token: await passwordToken(uid) });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).data, { status: 'sent' });
  assert.equal(brevoCalls.length, 1);
  const send = brevoCalls[0];
  assert.match(send.url, /api\.brevo\.com\/v3\/smtp\/email$/);
  assert.equal(send.headers['api-key'], 'test-brevo-key');
  assert.equal(send.body.to[0].email, uid + '@example.invalid', 'the address is the verified token claim, not a body field');
  assert.equal(send.body.subject, 'Confirmez votre adresse e-mail LeRoutier');
  assert.match(send.body.textContent, /verify-email\?oobCode=TEST-OOB-CODE/);
});

test('the raw action code never reaches the API response', async () => {
  const uid = 'opaque-' + randomUUID();
  const r = await call('/auth/email-verification', { token: await passwordToken(uid) });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes('oobCode') && !text.includes('TEST-OOB-CODE'), 'the action code must not be echoed');
});

test('an already-verified account answers idempotently and sends nothing', async () => {
  const before_ = brevoCalls.length;
  const uid = 'already-' + randomUUID();
  const r = await call('/auth/email-verification', { token: await passwordToken(uid, { verified: true }) });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).data, { status: 'already_verified' });
  assert.equal(brevoCalls.length, before_, 'no email for an already-verified account');
});

test('a Google identity cannot use the password verification flow', async () => {
  const token = await fixture.sign('google-' + randomUUID(), {
    email: 'google@example.invalid', email_verified: false, firebase: { sign_in_provider: 'google.com' } });
  const r = await call('/auth/email-verification', { token });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'FORBIDDEN');
});

test('a missing or invalid token is refused generically', async () => {
  assert.equal((await call('/auth/email-verification')).status, 401);
  assert.equal((await call('/auth/email-verification', { token: 'not-a-token' })).status, 401);
});

test('the resend ceiling is five per minute per identity', async () => {
  const uid = 'ceiling-' + randomUUID();
  const token = await passwordToken(uid);
  for (let i = 0; i < 5; i++) assert.equal((await call('/auth/email-verification', { token })).status, 200);
  const r = await call('/auth/email-verification', { token });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.code, 'RATE_LIMITED');
});

test('a Brevo failure answers a retryable 503, and the link never surfaces', async () => {
  const failing = createApi(db, config, fixture.resolver, undefined, fakeBrevo(500, { code: 'internal_error' }));
  const uid = 'brevo-down-' + randomUUID();
  const r = await failing(new Request('http://localhost/api/v1/auth/email-verification', {
    method: 'POST', headers: { authorization: 'Bearer ' + await passwordToken(uid) } }));
  assert.equal(r.status, 503);
  const payload = await r.json();
  assert.equal(payload.error.code, 'VERIFICATION_UNAVAILABLE');
  assert.match(payload.error.message, /confirmation/);
});

test('an Admin SDK failure is the same retryable refusal', async () => {
  const brokenAdmin = createApi(db, { ...config, firebaseAdmin: { available: true, generateEmailVerificationLink: async () => { throw new Error('google down'); } } }, fixture.resolver);
  const uid = 'admin-down-' + randomUUID();
  const r = await brokenAdmin(new Request('http://localhost/api/v1/auth/email-verification', {
    method: 'POST', headers: { authorization: 'Bearer ' + await passwordToken(uid) } }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, 'VERIFICATION_UNAVAILABLE');
});

test('a missing service account is reported as unavailable, never as something to retry', async () => {
  const noCredential = createApi(db, { ...config, firebaseAdmin: undefined }, fixture.resolver);
  const uid = 'no-credential-' + randomUUID();
  const r = await noCredential(new Request('http://localhost/api/v1/auth/email-verification', {
    method: 'POST', headers: { authorization: 'Bearer ' + await passwordToken(uid) } }));
  assert.equal(r.status, 503);
  // No credential is a configuration fault. Answering "réessayez plus tard"
  // invites a retry that cannot work, and hides the fault from whoever can fix it.
  assert.equal((await r.json()).error.code, 'EMAIL_UNAVAILABLE');
});

test('a refusal that retrying cannot fix is distinguished from a provider hiccup', async () => {
  // 401 from Brevo: the credential is wrong. Waiting will never change that.
  const badKey = createApi(db, config, fixture.resolver, undefined, fakeBrevo(401, { code: 'unauthorized' }));
  const refused = await badKey(new Request('http://localhost/api/v1/auth/email-verification', {
    method: 'POST', headers: { authorization: 'Bearer ' + await passwordToken('bad-key-' + randomUUID()) } }));
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error.code, 'EMAIL_UNAVAILABLE');
  // 500 from Brevo: the provider is unwell. Retrying is exactly right.
  const down = createApi(db, config, fixture.resolver, undefined, fakeBrevo(500, { code: 'internal_error' }));
  const retryable = await down(new Request('http://localhost/api/v1/auth/email-verification', {
    method: 'POST', headers: { authorization: 'Bearer ' + await passwordToken('down-' + randomUUID()) } }));
  assert.equal(retryable.status, 503);
  assert.equal((await retryable.json()).error.code, 'VERIFICATION_UNAVAILABLE');
});

test('every refused resend is recorded with its reason, and never with the address or the key', async () => {
  const lines = [];
  const realError = console.error;
  console.error = line => lines.push(String(line));
  try {
    const refused = createApi(db, config, fixture.resolver, undefined, fakeBrevo(402, { code: 'not_enough_credits' }));
    const uid = 'logged-' + randomUUID();
    await refused(new Request('http://localhost/api/v1/auth/email-verification', {
      method: 'POST', headers: { authorization: 'Bearer ' + await passwordToken(uid) } }));
    // The Admin path, which used to fail completely silently.
    const brokenAdmin = createApi(db, { ...config, firebaseAdmin: { available: true, generateEmailVerificationLink: async () => { throw new Error('google down'); } } }, fixture.resolver);
    await brokenAdmin(new Request('http://localhost/api/v1/auth/email-verification', {
      method: 'POST', headers: { authorization: 'Bearer ' + await passwordToken('admin-log-' + randomUUID()) } }));
  } finally { console.error = realError; }

  const events = lines.map(l => JSON.parse(l));
  assert.deepEqual(events.map(e => [e.event, e.stage, e.reason]), [
    ['verification_email_failed', 'send', 'quota_exhausted'],
    ['verification_email_failed', 'link', 'admin_unavailable'],
  ]);
  // The whole point of the log is diagnosis without disclosure.
  for (const line of lines) {
    assert.equal(line.includes('@example.invalid'), false, 'no recipient address');
    assert.equal(line.includes('test-brevo-key'), false, 'no credential');
    assert.equal(line.includes('oobCode'), false, 'no action code');
  }
});

test('a deployment with no Brevo credential says so at construction, not only when used', async () => {
  const lines = [];
  const realError = console.error;
  console.error = line => lines.push(String(line));
  try {
    createApi(db, { ...config, notificationProviders: { ...config.notificationProviders, brevo: { apiKey: '', fromAddress: '' } } }, fixture.resolver);
  } finally { console.error = realError; }
  // Every resend from this process would answer 503. That is a standing
  // condition of the deployment, and it is worth saying once at cold start
  // rather than only to whoever happens to trigger the failure.
  assert.deepEqual(lines.map(line => JSON.parse(line)),
    [{ event: 'email_channel_unavailable', channel: 'email', reason: 'invalid_configuration' }]);
});
