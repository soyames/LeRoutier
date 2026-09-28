// The second factor as the API enforces it: enrolment, the sign-in challenge,
// recovery codes, and — the part that matters most — that enabling a factor
// gates EVERY authenticated route rather than only the profile, while leaving
// every identity that has not enabled one exactly as it was.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { seed } from '@leroutier/database/seed';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { totpAt } from '@leroutier/database/totp';
import { createApi } from '../src/app.js';
import { jwtFixture } from './jwt-fixture.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
let fixture, api;

/** @param {string} path @param {{method?:string, token?:string|null, totp?:string|null, body?:any}} [options] */
const call = (path, { method = 'GET', token = null, totp = null, body } = {}) =>
  api(new Request('http://localhost/api/v1' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(totp ? { 'x-totp': totp } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
const codeFor = (secret, at = Date.now() / 1000) => totpAt(secret, at);

/** A verified password identity, as the provider would present it. */
const signIn = async uid => fixture.sign(uid, {
  email: uid + '@example.invalid', email_verified: true, firebase: { sign_in_provider: 'password' },
});

/** Signs in and turns the factor on, returning the secret and granted proof. */
async function enrolled(uid) {
  const token = await signIn(uid);
  await call('/me', { token });
  const start = await (await call('/me/totp/enrolment', { method: 'POST', token })).json();
  const activated = await (await call('/me/totp/activation', { method: 'POST', token, body: { code: codeFor(start.data.secret) } })).json();
  return { token, secret: start.data.secret, proof: activated.data.token, recoveryCodes: activated.data.recoveryCodes };
}

before(async () => {
  await migrate(db); await seed(db);
  fixture = await jwtFixture();
  Object.assign(config, { issuer: fixture.config.issuer, audience: fixture.config.audience, jwksUrl: fixture.config.jwksUrl });
  api = createApi(db, config, fixture.resolver);
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('an identity without a factor is untouched — the gate costs it nothing', async () => {
  const uid = 'plain-' + randomUUID();
  const token = await signIn(uid);
  const me = await call('/me', { token });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).data.has_second_factor, false);
  // A second call with no proof still works: most identities never enrol, and
  // this must not become a gate everybody has to pass.
  assert.equal((await call('/me', { token })).status, 200);
  assert.equal((await call('/me/totp', { token })).status, 200);
});

test('enrolment and activation work end to end, and the secret is never handed back', async () => {
  const uid = 'enrol-' + randomUUID();
  const token = await signIn(uid);
  await call('/me', { token });

  const start = await (await call('/me/totp/enrolment', { method: 'POST', token })).json();
  assert.match(start.data.uri, /^otpauth:\/\/totp\//);
  // Unconfirmed: it gates nothing yet, so this call still succeeds.
  assert.equal((await (await call('/me/totp', { token })).json()).data.enabled, false);

  const activation = await call('/me/totp/activation', { method: 'POST', token, body: { code: codeFor(start.data.secret) } });
  assert.equal(activation.status, 200);
  const activated = (await activation.json()).data;
  assert.equal(activated.recoveryCodes.length, 10);
  assert.ok(activated.token, 'the browser that activated is granted proof of it');

  const status = (await (await call('/me/totp', { token, totp: activated.token })).json()).data;
  assert.equal(status.enabled, true);
  assert.equal(status.recoveryCodesRemaining, 10);
  assert.equal('secret' in status, false, 'the secret is never returned again');
});

test('a confirmed factor gates every authenticated route, not just the profile', async () => {
  const { token, proof } = await enrolled('gated-' + randomUUID());
  // The point of the design: the bearer token opens the whole API, so a factor
  // that only guarded /me would be decorative.
  for (const [path, method] of [['/me', 'GET'], ['/me/bookings', 'GET'], ['/notifications', 'GET'], ['/me/privacy', 'GET']]) {
    const refused = await call(path, { method, token });
    assert.equal(refused.status, 403, `${path} must be gated`);
    assert.equal((await refused.json()).error.code, 'TOTP_REQUIRED');
  }
  // With the proof this browser earned, the same calls succeed.
  assert.equal((await call('/me', { token, totp: proof })).status, 200);
  assert.equal((await call('/notifications', { token, totp: proof })).status, 200);
});

test('a wrong code is refused, and a right one grants the proof', async () => {
  const uid = 'challenge-' + randomUUID();
  const { token, secret, proof } = await enrolled(uid);
  assert.equal((await call('/me', { token })).status, 403);

  const wrong = await call('/auth/totp', { method: 'POST', token, body: { code: '000000' } });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error.code, 'TOTP_INVALID');
  // Still refused: a failed attempt must not open anything.
  assert.equal((await call('/me', { token })).status, 403);

  // The step activation verified is spent, so this is the NEXT step's code —
  // exactly what a real user types thirty seconds later.
  const granted = await call('/auth/totp', { method: 'POST', token, body: { code: codeFor(secret, Date.now() / 1000 + 30) } });
  assert.equal(granted.status, 200);
  const proofToken = (await granted.json()).data.token;
  assert.equal((await call('/me', { token, totp: proofToken })).status, 200);
  // A proof minted for somebody else is worth nothing here.
  assert.equal((await call('/me', { token, totp: 'not-a-real-token' })).status, 403);
  assert.ok(proof);
});

test('a recovery code gets somebody back in when the phone is gone', async () => {
  const { token, recoveryCodes } = await enrolled('recovery-' + randomUUID());
  assert.equal((await call('/me', { token })).status, 403);
  const granted = await call('/auth/totp', { method: 'POST', token, body: { code: recoveryCodes[0] } });
  assert.equal(granted.status, 200);
  const data = (await granted.json()).data;
  assert.equal(data.method, 'recovery');
  assert.equal(data.recoveryCodesRemaining, 9, 'spending one is reported honestly');
  assert.equal((await call('/me', { token, totp: data.token })).status, 200);
  // Single use: the same code cannot be spent twice.
  assert.equal((await call('/auth/totp', { method: 'POST', token, body: { code: recoveryCodes[0] } })).status, 403);
});

test('disabling requires the factor, and removing it releases the gate', async () => {
  const uid = 'disable-' + randomUUID();
  const { token, secret, proof } = await enrolled(uid);
  // Refused with the wrong code...
  assert.equal((await call('/me/totp/disable', { method: 'POST', token, totp: proof, body: { code: '000000' } })).status, 403);
  // ...and refused without having passed the factor at all, even with a code
  // that would be correct: the session itself has to have earned it.
  assert.equal((await call('/me/totp/disable', { method: 'POST', token, body: { code: codeFor(secret, Date.now() / 1000 + 30) } })).status, 403);

  const off = await call('/me/totp/disable', { method: 'POST', token, totp: proof, body: { code: codeFor(secret, Date.now() / 1000 + 30) } });
  assert.equal(off.status, 200);
  // The factor is gone, so the gate is gone with it.
  assert.equal((await call('/me', { token })).status, 200);
});
