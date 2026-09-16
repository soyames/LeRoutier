import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicAuthConfig, serverConfig, authConfig, FIREBASE_JWKS_URL } from '../src/index.js';
import { safeReturnPath } from '../src/firebase.js';

// The gate that decides whether sign-in is offered at all.
//
// Its job is to refuse: a half-configured provider must produce no sign-in
// button rather than a button that fails after the user has committed to it.
// Everything here is a pure function, so it is tested without a browser.

const PROJECT = 'leroutier-example';
const env = extra => ({
  FIREBASE_PROJECT_ID: PROJECT,
  FIREBASE_API_KEY: 'web-api-key-value',
  FIREBASE_AUTH_DOMAIN: `${PROJECT}.firebaseapp.com`,
  FIREBASE_APP_ID: '1:123:web:abc',
  ...extra,
});

// ------------------------------------------------------- derived, not typed --
test('issuer, audience and key set are derived from the project id', () => {
  const config = authConfig(env());
  assert.equal(config.issuer, `https://securetoken.google.com/${PROJECT}`);
  assert.equal(config.audience, PROJECT);
  assert.equal(config.jwksUrl, FIREBASE_JWKS_URL);
});

test('one variable cannot disagree with itself', () => {
  // Three hand-entered values can drift apart; a mistyped issuer or audience is
  // precisely what makes a verifier accept another project's tokens.
  const a = authConfig(env({ FIREBASE_PROJECT_ID: 'project-one' }));
  const b = authConfig(env({ FIREBASE_PROJECT_ID: 'project-two' }));
  assert.notEqual(a.issuer, b.issuer);
  assert.notEqual(a.audience, b.audience);
  assert.ok(a.issuer.endsWith('project-one'));
  assert.equal(a.jwksUrl, b.jwksUrl, 'the key set is the same for every Firebase project');
});

test('without a project id the verifier has nothing to verify against', () => {
  const config = authConfig({});
  assert.equal(config.issuer, undefined);
  assert.equal(config.audience, undefined);
  assert.equal(config.jwksUrl, undefined);
});

// -------------------------------------------------------- what is published --
test('a complete configuration is published to the browser', () => {
  const published = publicAuthConfig(authConfig(env()));
  assert.equal(published.firebase.projectId, PROJECT);
  assert.equal(published.firebase.authDomain, `${PROJECT}.firebaseapp.com`);
  assert.deepEqual(published.firebase.providers, ['google']);
  assert.equal(published.demoLogin, false);
});

test('only the four browser-facing identifiers, and the providers', () => {
  const published = publicAuthConfig(authConfig(env()));
  assert.deepEqual(Object.keys(published.firebase).sort(), ['apiKey', 'appId', 'authDomain', 'projectId', 'providers']);
});

test('nothing server-side is published alongside it', () => {
  const published = publicAuthConfig({
    ...authConfig(env()),
    databaseUrl: 'postgresql://u:p@host/db',
    fedapay: { secretKey: 'sk-live-xyz' },
  });
  const text = JSON.stringify(published);
  // Not a credential, and not even the issuer or key set the API verifies
  // against: the browser needs neither and must not be told either.
  for (const secret of ['postgresql://', 'sk-live-xyz', 'securetoken', 'jwks', 'googleapis']) {
    assert.equal(text.includes(secret), false, `${secret} reached the browser payload`);
  }
});

test('any missing Firebase value disables sign-in entirely', () => {
  for (const missing of ['FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_APP_ID']) {
    assert.equal(publicAuthConfig(authConfig(env({ [missing]: undefined }))).firebase, null,
      `${missing} missing must disable sign-in`);
  }
});

test('an empty string is as absent as undefined', () => {
  assert.equal(publicAuthConfig(authConfig(env({ FIREBASE_API_KEY: '' }))).firebase, null);
});

test('demo login can never be on in a deployed environment', () => {
  const base = { DATABASE_URL: 'postgresql://placeholder', ALLOW_DEMO_LOGIN: 'true' };
  assert.equal(serverConfig({ ...base, VERCEL: '1' }).demoLogin, false);
  assert.equal(serverConfig({ ...base, NODE_ENV: 'production' }).demoLogin, false);
  assert.equal(serverConfig(base).demoLogin, true, 'it still works for local development');
});

test('serverConfig carries the same identity slice as authConfig', () => {
  const full = serverConfig({ DATABASE_URL: 'postgresql://placeholder', ...env() });
  assert.equal(full.issuer, `https://securetoken.google.com/${PROJECT}`);
  assert.equal(full.audience, PROJECT);
  assert.equal(full.jwksUrl, FIREBASE_JWKS_URL);
});

// ------------------------------------------------------------ return path --
test('only a same-origin absolute path survives a sign-in round trip', () => {
  assert.equal(safeReturnPath('/tickets/abc'), '/tickets/abc');
  assert.equal(safeReturnPath('/work/today'), '/work/today');
});

test('the return path cannot be turned into an open redirect', () => {
  for (const hostile of [
    'https://evil.example/steal',      // absolute URL
    '//evil.example/steal',            // protocol-relative
    'javascript:alert(1)',             // scheme
    'tickets/abc',                     // relative, would resolve off-route
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(safeReturnPath(/** @type {any} */ (hostile)), '/', `${JSON.stringify(hostile)} must not be returned to`);
  }
});

test('the callback route is never itself a return destination', () => {
  assert.equal(safeReturnPath('/auth/callback'), '/');
  assert.equal(safeReturnPath('/auth/callback?code=abc&state=xyz'), '/');
});
