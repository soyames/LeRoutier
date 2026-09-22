import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicAuthConfig, serverConfig, authConfig, FIREBASE_JWKS_URL } from '../src/index.js';
import { safeReturnPath, signInFailure } from '../src/firebase.js';
import { createSyncQueue, clearQueuedActions } from '../src/offline.js';

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
    '/\\evil.example/steal',
    '/\t/evil.example',
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

// ------------------------------------------------- provider failures, told --
test('a provider failure is never shown to the user in the provider’s own words', () => {
  // Firebase messages read "Firebase: Error (auth/email-already-in-use)." —
  // developer-facing, and they name the provider and its internal code. This
  // one reached the registration form verbatim before it was mapped.
  for (const code of ['auth/email-already-in-use', 'auth/unauthorized-domain', 'auth/invalid-credential',
    'auth/network-request-failed', 'auth/this-code-does-not-exist']) {
    const failure = signInFailure(Object.assign(new Error('Firebase: Error (' + code + ').'), { code }));
    assert.ok(!/firebase|auth\//i.test(failure.message), `${code} leaked the provider's wording`);
    assert.ok(failure.message.length > 10, `${code} produced no usable message`);
  }
});

test('a failure that retrying cannot fix does not ask the user to retry', () => {
  // The loop this closes: an unauthorized domain is a Firebase Console setting.
  // "Réessayez" sends somebody round it forever, and they never find out that
  // nothing they can do will help.
  for (const code of ['auth/unauthorized-domain', 'auth/operation-not-allowed', 'auth/invalid-api-key',
    'auth/account-exists-with-different-credential', 'auth/user-disabled', 'auth/email-already-in-use']) {
    const failure = signInFailure(Object.assign(new Error('x'), { code }));
    assert.equal(failure.retryable, false, `${code} is a fact about configuration or the account`);
    assert.ok(!/[Rr]éessayez/.test(failure.message), `${code} still tells the user to try again`);
  }
  // And the transient ones do say so, because there trying again is the answer.
  for (const code of ['auth/network-request-failed', 'auth/too-many-requests', 'auth/popup-closed-by-user']) {
    assert.equal(signInFailure(Object.assign(new Error('x'), { code })).retryable, true);
  }
});

test('the provider error survives as the cause, for diagnosis', () => {
  const original = Object.assign(new Error('Firebase: Error (auth/unauthorized-domain).'), { code: 'auth/unauthorized-domain' });
  const failure = signInFailure(original);
  assert.equal(failure.cause, original, 'the original is kept where a developer can read it');
  assert.equal(failure.reason, 'auth/unauthorized-domain', 'and the code travels for logging');
});

test('an unrecognised failure is still answered in the product’s language', () => {
  assert.match(signInFailure(new Error('boom')).message, /Impossible de démarrer la connexion/);
  assert.match(signInFailure(new Error('boom'), 'password').message, /Impossible de vous connecter/);
  assert.equal(signInFailure(undefined).reason, 'unknown');
});

// ---------------------------------------------------- crew queue on sign-out --
test('signing out clears every queued crew action left on the device', () => {
  // A pending board/alight row carries the passenger's ticket code. The queue
  // is keyed per user, so the app cannot show it to the next signed-in person
  // — but it used to outlive sign-out in localStorage on a shared station
  // handset, where anybody holding the device can read it.
  const store = new Map();
  /** @type {any} */
  const storage = {
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  const queue = createSyncQueue(storage, 'driver-1');
  queue.enqueue('board', { serviceId: 'svc-1', bookingId: 'bk-1', stopSequence: 0, code: 'LR-AAAA-BBBB-CCCC-DDDD' });
  createSyncQueue(storage, 'driver-2').enqueue('alight', { serviceId: 'svc-2', bookingId: 'bk-2', stopSequence: 3 });
  storage.setItem('leroutier:unrelated', 'keep me');
  assert.ok(JSON.stringify([...store.values()]).includes('LR-AAAA-BBBB-CCCC-DDDD'), 'the code is really there first');

  assert.equal(clearQueuedActions(storage), 2, 'every crew queue on the device goes, not only the signed-in user’s');
  assert.equal(queue.read().length, 0);
  assert.ok(!JSON.stringify([...store.values()]).includes('LR-AAAA-BBBB-CCCC-DDDD'), 'no ticket code survives sign-out');
  assert.equal(storage.getItem('leroutier:unrelated'), 'keep me', 'unrelated keys are left alone');
});

test('a storage that refuses to be read never breaks sign-out', () => {
  /** @type {any} */
  const denied = { get length() { throw new Error('private mode'); }, key: () => null, removeItem: () => {} };
  assert.equal(clearQueuedActions(denied), 0);
});
