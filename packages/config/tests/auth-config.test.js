import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicAuthConfig, serverConfig, authConfig, FIREBASE_JWKS_URL } from '../src/index.js';
import { safeReturnPath, signInFailure, browserAuthDomain, readRedirectMarker, writeRedirectMarker, clearRedirectMarker, preferGoogleRedirect } from '../src/firebase.js';
import { createSyncQueue, clearQueuedActions, OFFLINE_TTL } from '../src/offline.js';

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
  // Local development keeps Google available for regression work; the
  // production default (absent) is tested separately below.
  GOOGLE_AUTH_ENABLED: 'true',
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

// ---------------------------------------------------- the Google feature gate --
test('Google sign-in is offered only when explicitly enabled', () => {
  assert.deepEqual(publicAuthConfig(authConfig(env())).firebase.providers, ['google']);
  assert.deepEqual(publicAuthConfig(authConfig(env({ GOOGLE_AUTH_ENABLED: 'false' }))).firebase.providers, []);
});

test('an absent or unrecognised flag hides Google — the production default', () => {
  // Production sets nothing, and "nothing" must mean hidden: a broken OAuth
  // provider is never offered by accident. Any value that is not literally
  // 'true' behaves like unset.
  assert.deepEqual(publicAuthConfig(authConfig(env({ GOOGLE_AUTH_ENABLED: undefined }))).firebase.providers, []);
  for (const value of ['', 'TRUE', 'yes', '1', 'on', 'true ']) {
    assert.deepEqual(publicAuthConfig(authConfig(env({ GOOGLE_AUTH_ENABLED: value }))).firebase.providers, [],
      `${JSON.stringify(value)} must not enable Google`);
  }
});

test('hiding Google never hides e-mail/password sign-in', () => {
  // E-mail/password needs the same Firebase identifiers, not the provider
  // list: the published config stays complete with an empty provider list.
  const published = publicAuthConfig(authConfig(env({ GOOGLE_AUTH_ENABLED: undefined })));
  assert.ok(published.firebase, 'the Firebase identifiers must still be published');
  assert.deepEqual(published.firebase.providers, []);
  assert.equal(published.firebase.apiKey, 'web-api-key-value');
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

// ----------------------------------------------------------- auth domain ----
test('every branded host resolves to ONE authoritative production auth origin', () => {
  // The Vercel platform may serve the app on the apex or on www, but the OAuth
  // callback is registered with Google for exactly one redirect URI. Both hosts
  // must converge on the apex — mirroring www would produce a second,
  // unregistered handler and Google rejects it with redirect_uri_mismatch.
  const config = { authDomain: 'leroutier-df848.firebaseapp.com' };
  assert.equal(browserAuthDomain(config, { hostname: 'leroutier.app' }), 'leroutier.app');
  assert.equal(browserAuthDomain(config, { hostname: 'www.leroutier.app' }), 'leroutier.app');
  assert.equal(browserAuthDomain(config, { hostname: 'LEROUTIER.APP' }), 'leroutier.app', 'host casing is normalised');
});

test('non-production hosts keep the configured Firebase helper domain', () => {
  const config = { authDomain: 'leroutier-df848.firebaseapp.com' };
  assert.equal(browserAuthDomain(config, { hostname: 'localhost' }), 'leroutier-df848.firebaseapp.com');
  assert.equal(browserAuthDomain(config, { hostname: '127.0.0.1' }), 'leroutier-df848.firebaseapp.com');
  assert.equal(browserAuthDomain(config, { hostname: 'le-routier.vercel.app' }), 'leroutier-df848.firebaseapp.com');
});

// ------------------------------------------------------- redirect marker ----
function memoryStorage() {
  const store = new Map();
  return {
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
    clear: () => { store.clear(); },
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    keys: () => [...store.keys()],
  };
}

test('the redirect marker is durable storage, not per-tab session state', () => {
  const storage = memoryStorage();
  writeRedirectMarker('/tickets/abc', storage);
  assert.deepEqual(readRedirectMarker(storage), { returnTo: '/tickets/abc' });
  // A hostile or accidental value can never become a return destination.
  storage.setItem('leroutier:auth-redirect', JSON.stringify({ returnTo: 'https://evil.example/x' }));
  assert.deepEqual(readRedirectMarker(storage), { returnTo: '/' });
  clearRedirectMarker(storage);
  assert.equal(readRedirectMarker(storage), null);
});

test('a corrupted redirect marker is treated as absent, never thrown', () => {
  const storage = memoryStorage();
  storage.setItem('leroutier:auth-redirect', '{not json');
  assert.equal(readRedirectMarker(storage), null);
  storage.setItem('leroutier:auth-redirect', '"just a string"');
  assert.equal(readRedirectMarker(storage), null);
});

test('storage that refuses to be touched never breaks the marker helpers', () => {
  const denied = { length: 0, key: () => null, clear: () => {},
    getItem: () => { throw new Error('private mode'); }, setItem: () => { throw new Error('private mode'); }, removeItem: () => { throw new Error('private mode'); } };
  assert.equal(readRedirectMarker(denied), null);
  writeRedirectMarker('/x', denied);
  clearRedirectMarker(denied);
});

test('the redirect strategy prefers the redirect flow on installed PWAs and mobile', () => {
  const previousWindow = globalThis.window, previousNavigator = globalThis.navigator;
  const mediaQueryList = matches => ({ matches, media: '', onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false });
  try {
    /** @type {any} */ (globalThis).window = { matchMedia: q => mediaQueryList(q === '(display-mode: standalone)') };
    assert.equal(preferGoogleRedirect(), true, 'display-mode: standalone is an installed PWA');
    /** @type {any} */ (globalThis).window = { matchMedia: () => mediaQueryList(false) };
    assert.equal(preferGoogleRedirect(), false, 'a non-mobile UA without standalone keeps the popup flow');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140 Mobile' } });
    assert.equal(preferGoogleRedirect(), true, 'a mobile UA keeps the redirect flow');
  } finally {
    globalThis.window = previousWindow;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
  }
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

test('signing out clears the device even when no provider was configured', () => {
  // The clearing used to hang off signOutFirebase, which only runs when
  // /auth/config resolved. A crew member whose config fetch had failed signed
  // out of a shared station handset and left the passengers' ticket codes in
  // localStorage. Clearing the device is what signing out MEANS; it cannot
  // depend on which provider happened to be in play.
  const store = new Map();
  /** @type {any} */
  const storage = {
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  createSyncQueue(storage, 'crew-1').enqueue('board',
    { serviceId: 'svc-1', bookingId: 'bk-1', stopSequence: 0, code: 'LR-DEAD-BEEF-CAFE-0001' });
  assert.ok(JSON.stringify([...store.values()]).includes('LR-DEAD-BEEF-CAFE-0001'));
  assert.equal(clearQueuedActions(storage), 1);
  assert.ok(!JSON.stringify([...store.values()]).includes('LR-DEAD-BEEF-CAFE-0001'));
});

test('a queued action is scoped to its own crew member and replays exactly once', async () => {
  const store = new Map();
  /** @type {any} */
  const storage = {
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  const mine = createSyncQueue(storage, 'crew-a');
  const theirs = createSyncQueue(storage, 'crew-b');
  mine.enqueue('board', { serviceId: 's1', bookingId: 'b1', stopSequence: 0 });
  theirs.enqueue('board', { serviceId: 's1', bookingId: 'b2', stopSequence: 0 });
  assert.equal(mine.read().length, 1, 'one crew member never sees the other queue');
  assert.equal(theirs.read().length, 1);

  // Enqueuing the identical action twice while it is still waiting returns the
  // same row: a driver double-tapping a tile must not board somebody twice.
  const first = mine.read()[0];
  const again = mine.enqueue('board', { serviceId: 's1', bookingId: 'b1', stopSequence: 0 });
  assert.equal(again.id, first.id);

  // Replay is keyed on the row id, which the server uses as the idempotency
  // key, so the same action reaching the server twice is one action.
  const sent = [];
  await mine.sync(async row => { sent.push(row.id); });
  assert.deepEqual(sent, [first.id]);
  await mine.sync(async row => { sent.push(row.id); });
  assert.deepEqual(sent, [first.id], 'a succeeded row is never sent again');
  // And the ticket code does not linger on the device once it has landed.
  assert.ok(!JSON.stringify([...store.values()]).includes('b1') ||
    !JSON.stringify(mine.read()[0].payload).includes('bookingId'));
});

// Regression: an expired row used to hide behind the TTL filter while its
// payload (ticket code included) stayed in localStorage until some later
// write happened to clean it up. Found by /qa on 2026-09-23.
test('an action past its TTL is dropped from storage, not kept with its ticket code', async () => {
  const store = new Map();
  /** @type {any} */
  const storage = {
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  let now = Date.parse('2026-09-23T05:00:00Z');
  const queue = createSyncQueue(storage, 'crew-ttl', () => now);
  queue.enqueue('board', { serviceId: 'svc-1', bookingId: 'bk-1', stopSequence: 0, code: 'LR-TTL0-TTL0-TTL0-0001' });
  assert.ok(JSON.stringify([...store.values()]).includes('LR-TTL0-TTL0-TTL0-0001'), 'the code is really there first');

  now += OFFLINE_TTL + 1;
  assert.equal(queue.read().length, 0, 'the expired action is no longer visible');
  assert.ok(!JSON.stringify([...store.values()]).includes('LR-TTL0-TTL0-TTL0-0001'),
    'the expired ticket code leaves the device at read time, without waiting for a later write');

  // A fresh action still queues and syncs normally; the purge must not eat it.
  const fresh = queue.enqueue('alight', { serviceId: 'svc-1', bookingId: 'bk-2', stopSequence: 1 });
  const sent = [];
  await queue.sync(async row => { sent.push(row.id); });
  assert.deepEqual(sent, [fresh.id], 'only the unexpired action is ever sent');
});

test('a 401 during replay returns the action to pending and names reconnection', async () => {
  const store = new Map();
  /** @type {any} */
  const storage = {
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  const queue = createSyncQueue(storage, 'crew-relogin');
  const row = queue.enqueue('board', { serviceId: 'svc-1', bookingId: 'bk-1', stopSequence: 0 });
  const unauthorized = Object.assign(new Error('unauthorized'), { status: 401 });
  await queue.sync(async () => { throw unauthorized; });
  const after = queue.read()[0];
  assert.equal(after.state, 'pending', 'the action stays replaysable, not parked or discarded');
  assert.match(after.error, /Reconnectez-vous/, 'the crew are told what to do');

  // Once the session is back, the same row replays and lands.
  await queue.sync(async () => {});
  assert.equal(queue.read()[0].state, 'succeeded');
  assert.ok(queue.read()[0].id === row.id, 'the same row id keeps its idempotency key across the relogin');
});

test('three failed attempts park the action visibly, and retry resets it', async () => {
  const store = new Map();
  /** @type {any} */
  const storage = {
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  const queue = createSyncQueue(storage, 'crew-fail');
  const row = queue.enqueue('board', { serviceId: 'svc-1', bookingId: 'bk-1', stopSequence: 0 });
  const network = Object.assign(new Error('network down'), { status: 0 });
  for (let i = 0; i < 3; i++) await queue.sync(async () => { throw network; });
  assert.equal(queue.read()[0].state, 'failed');
  assert.equal(queue.read()[0].attempts, 3);
  assert.match(queue.read()[0].error, /Échec réseau/, 'an honest network failure, never a raw system error');

  const sent = [];
  await queue.sync(r => { sent.push(r.id); });
  assert.deepEqual(sent, [], 'sync does not keep hammering an exhausted action by itself');
  queue.retry(row.id);
  await queue.sync(r => { sent.push(r.id); });
  assert.deepEqual(sent, [row.id], 'retry resets the attempts and replays');
  assert.equal(queue.read()[0].state, 'succeeded');
});
