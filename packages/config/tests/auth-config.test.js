import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicAuthConfig, serverConfig } from '../src/index.js';
import { safeReturnPath } from '../src/oidc.js';

// The gate that decides whether sign-in is offered at all.
//
// Its job is to refuse: a half-configured provider must produce no sign-in
// button rather than a button that fails after the user has committed to it.
// Everything here is a pure function, so it is tested without a browser.

const COMPLETE = {
  issuer: 'https://identity.example.invalid',
  jwksUrl: 'https://identity.example.invalid/oauth/v2/keys',
  audience: 'project-id-123',
  oidcClientId: 'client-id-456',
  oidcRedirectUris: ['https://le-routier.vercel.app/auth/callback'],
  oidcScope: 'openid profile',
  demoLogin: false,
};

test('a complete configuration is published to the browser', () => {
  const published = publicAuthConfig(COMPLETE);
  assert.equal(published.oidc.authority, COMPLETE.issuer);
  assert.equal(published.oidc.clientId, COMPLETE.oidcClientId);
  assert.deepEqual(published.oidc.redirectUris, COMPLETE.oidcRedirectUris);
  assert.equal(published.demoLogin, false);
});

test('nothing secret is ever published alongside it', () => {
  const published = publicAuthConfig({ ...COMPLETE, databaseUrl: 'postgresql://u:p@host/db', fedapaySecretKey: 'sk-live-xyz' });
  const text = JSON.stringify(published);
  for (const secret of ['postgresql://', 'sk-live-xyz', 'jwksUrl', 'audience']) {
    assert.equal(text.includes(secret), false, `${secret} reached the browser payload`);
  }
  // The audience and the JWKS URL are server-side validation inputs; the
  // browser needs neither, so neither is sent.
  assert.deepEqual(Object.keys(published.oidc).sort(), ['authority', 'clientId', 'redirectUris', 'resource', 'scope']);
});

test('any missing required value disables sign-in entirely', () => {
  for (const missing of ['issuer', 'jwksUrl', 'audience', 'oidcClientId']) {
    assert.equal(publicAuthConfig({ ...COMPLETE, [missing]: undefined }).oidc, null, `${missing} missing must disable sign-in`);
  }
  assert.equal(publicAuthConfig({ ...COMPLETE, oidcRedirectUris: [] }).oidc, null, 'no redirect URI must disable sign-in');
});

test('a non-HTTPS issuer, JWKS or redirect URI disables sign-in', () => {
  assert.equal(publicAuthConfig({ ...COMPLETE, issuer: 'http://identity.example.invalid' }).oidc, null);
  assert.equal(publicAuthConfig({ ...COMPLETE, jwksUrl: 'http://identity.example.invalid/keys' }).oidc, null);
  // The common local-development mistake: one http callback in the list takes
  // the whole production configuration down rather than half-enabling it.
  assert.equal(publicAuthConfig({ ...COMPLETE,
    oidcRedirectUris: ['https://le-routier.vercel.app/auth/callback', 'http://localhost:4176/auth/callback'] }).oidc, null);
});

test('a malformed URL disables sign-in instead of throwing', () => {
  assert.equal(publicAuthConfig({ ...COMPLETE, issuer: 'not a url' }).oidc, null);
});

test('demo login can never be on in a deployed environment', () => {
  const base = { DATABASE_URL: 'postgresql://placeholder', ALLOW_DEMO_LOGIN: 'true' };
  assert.equal(serverConfig({ ...base, VERCEL: '1' }).demoLogin, false);
  assert.equal(serverConfig({ ...base, NODE_ENV: 'production' }).demoLogin, false);
  assert.equal(serverConfig(base).demoLogin, true, 'it still works for local development');
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
  // Otherwise a completed sign-in would land back on the callback and try to
  // redeem an already-used authorization code.
  assert.equal(safeReturnPath('/auth/callback'), '/');
  assert.equal(safeReturnPath('/auth/callback?code=abc&state=xyz'), '/');
});
