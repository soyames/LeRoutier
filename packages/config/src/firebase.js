// Firebase Authentication in the browser.
//
// One provider today — Google — and one job: obtain a Firebase ID token the
// API can verify. LeRoutier's roles are never read from this layer: whatever
// Google says about a person, the database decides what they may do.
//
// The SDK is loaded lazily. A visitor who only searches for a bus never pays
// for an authentication library they do not use.

import { clearQueuedActions } from './offline.js';

const RETURN_TO = 'leroutier:return-to';
const PENDING_REDIRECT = 'leroutier:auth-redirect';
const FIREBASE_APP_NAME = 'leroutier-auth';
const BRANDED_AUTH_HOSTS = new Set(['leroutier.app', 'www.leroutier.app']);

// Only a same-origin, absolute path may be returned to after sign-in. Anything
// else — an absolute URL, a protocol-relative "//evil.example", the callback
// route itself — falls back to the home page. This is the open-redirect guard.
export function safeReturnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\') || [...value].some(c=>c.charCodeAt(0)<=32)) return '/';
  if (value.startsWith('/auth/callback')) return '/';
  return value;
}

/** Remember where the user was, so sign-in returns them there. */
export function rememberReturnPath(path) {
  try { window.sessionStorage.setItem(RETURN_TO, safeReturnPath(path)); } catch { /* private mode */ }
}
export function takeReturnPath() {
  try {
    const value = window.sessionStorage.getItem(RETURN_TO);
    window.sessionStorage.removeItem(RETURN_TO);
    return safeReturnPath(value);
  } catch { return '/'; }
}

/**
 * The production PWA deliberately serves Firebase's helper routes through the
 * LeRoutier origin. Firebase recommends this reverse-proxy pattern for apps
 * hosted outside Firebase Hosting because it keeps the auth helper same-origin
 * and avoids third-party-storage failures. It also means the account chooser
 * is branded with LeRoutier's domain instead of *.firebaseapp.com.
 *
 * Local development keeps the configured Firebase domain because localhost
 * does not proxy /__/auth to the Firebase project.
 *
 * @param {{authDomain?: string}|null|undefined} config
 * @param {{hostname?: string}|null|undefined} [location] only `hostname` is
 *   read, so a caller (and a test) may pass that alone rather than a whole
 *   `Location`.
 * @returns {string|undefined}
 */
export function browserAuthDomain(config, location = globalThis.window?.location) {
  const hostname = String(location?.hostname || '').toLowerCase();
  return BRANDED_AUTH_HOSTS.has(hostname) ? hostname : config?.authDomain;
}

let cached = null;

/**
 * Initialises Firebase once, from configuration the API served at runtime.
 * Returns null when sign-in is not configured, so every caller can simply ask
 * and get an honest answer.
 */
export async function firebaseAuth(config) {
  if (!config?.apiKey || !config?.authDomain || !config?.projectId || !config?.appId) return null;
  const authDomain = browserAuthDomain(config);
  if (!authDomain) return null;
  const key = `${config.projectId}:${config.appId}:${authDomain}`;
  if (cached?.key === key) return cached;

  const [{ initializeApp, getApps, deleteApp }, auth] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
  ]);

  // Use one dedicated Firebase app. Older flows in the bundle must not be able
  // to leave an app initialised with firebaseapp.com and silently win forever.
  let app = getApps().find(candidate => candidate.name === FIREBASE_APP_NAME) ?? null;
  if (app && app.options.authDomain !== authDomain) {
    await deleteApp(app);
    app = null;
  }
  if (!app) app = initializeApp({
    apiKey: config.apiKey,
    authDomain,
    projectId: config.projectId,
    appId: config.appId,
  }, FIREBASE_APP_NAME);

  const instance = auth.getAuth(app);
  // Tokens live for the tab and no longer. A shared handset at a station
  // should not sign the next person in as the last one.
  await auth.setPersistence(instance, auth.browserSessionPersistence)
    .catch(() => auth.setPersistence(instance, auth.inMemoryPersistence));
  cached = { key, auth: instance, sdk: auth };
  return cached;
}

/**
 * Starts a Google sign-in.
 *
 * Popup first, redirect as a fallback. Both use the same branded authDomain in
 * production, so the helper stays on the LeRoutier origin. Mobile browsers that
 * block the popup can therefore fall back to redirect without crossing to the
 * Firebase Hosting domain.
 */
export async function signInWithGoogle(config, returnTo = '/') {
  const ready = await firebaseAuth(config);
  if (!ready) throw new Error('auth-unavailable');
  const { sdk, auth } = ready;

  const provider = new sdk.GoogleAuthProvider();
  // Identity and basic profile only. No Gmail, Drive, Calendar or Contacts —
  // the public privacy policy says so, and this is where that is kept true.
  provider.addScope('openid');
  provider.addScope('profile');
  provider.addScope('email');

  rememberReturnPath(returnTo);
  try {
    const result = await sdk.signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    const code = error?.code ?? '';
    if (code === 'auth/popup-blocked') {
      // Mobile browsers sometimes block a first popup spuriously; one retry
      // avoids a full redirect round-trip before falling back to it.
      try {
        const retried = await sdk.signInWithPopup(auth, provider);
        return retried.user;
      } catch { /* the redirect fallback below still applies */ }
    }
    if (['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/operation-not-supported-in-this-environment'].includes(code)) {
      if (code === 'auth/popup-closed-by-user') throw error;
      try { window.sessionStorage.setItem(PENDING_REDIRECT, '1'); } catch { /* private mode */ }
      await sdk.signInWithRedirect(auth, provider);
      // The page navigates away; nothing after this runs.
      return null;
    }
    throw error;
  }
}

/**
 * Completes a redirect sign-in, if one is in flight.
 *
 * Called once on load. It asks Firebase only when a redirect was actually
 * started, so a normal visit costs nothing.
 */
export async function completeRedirectSignIn(config) {
  let pending = false;
  try { pending = window.sessionStorage.getItem(PENDING_REDIRECT) === '1'; } catch { /* private mode */ }
  if (!pending) return null;
  try { window.sessionStorage.removeItem(PENDING_REDIRECT); } catch { /* private mode */ }
  const ready = await firebaseAuth(config);
  if (!ready) return null;
  const result = await ready.sdk.getRedirectResult(ready.auth).catch(() => null);
  return result?.user ?? null;
}

/**
 * A current ID token for the API.
 *
 * Firebase refreshes it when it is close to expiry, which is why the token is
 * asked for per request rather than held: a long booking should not fail on a
 * token that went stale while the user was reading.
 */
export async function idToken(config, { force = false } = {}) {
  const ready = await firebaseAuth(config);
  const user = ready?.auth?.currentUser;
  return user ? user.getIdToken(force) : null;
}

/** Notifies on sign-in and sign-out, including a restored session. */
export async function onAuthChange(config, callback) {
  const ready = await firebaseAuth(config);
  if (!ready) return () => {};
  return ready.sdk.onAuthStateChanged(ready.auth, callback);
}

/**
 * Standard registration: one Firebase Email/Password account, which becomes
 * the SAME LeRoutier identity as any Google account — the API only ever sees
 * the Firebase ID token. Passwords never touch LeRoutier's API or database.
 */
export async function createAccountWithEmail(config, { email, password }) {
  const ready = await firebaseAuth(config);
  if (!ready) throw new Error('auth-unavailable');
  return ready.sdk.createUserWithEmailAndPassword(ready.auth, String(email).trim(), String(password));
}

/** Email/password sign-in; the same single-identity model as Google. */
export async function signInWithEmail(config, { email, password }) {
  const ready = await firebaseAuth(config);
  if (!ready) throw new Error('auth-unavailable');
  return ready.sdk.signInWithEmailAndPassword(ready.auth, String(email).trim(), String(password));
}

/** Firebase sends the reset email; nothing is stored or emailed by LeRoutier. */
export async function sendPasswordReset(config, email) {
  const ready = await firebaseAuth(config);
  if (!ready) throw new Error('auth-unavailable');
  await ready.sdk.sendPasswordResetEmail(ready.auth, String(email).trim());
}

export async function signOutFirebase(config) {
  const ready = await firebaseAuth(config);
  if (ready) await ready.sdk.signOut(ready.auth).catch(() => {});
  try {
    window.sessionStorage.removeItem(RETURN_TO);
    window.sessionStorage.removeItem(PENDING_REDIRECT);
  } catch { /* private mode */ }
  // Crew work is queued in localStorage while offline, and a pending
  // board/alight row carries the passenger's ticket code. Signing out on a
  // shared station handset must leave nothing of the previous person behind.
  try { clearQueuedActions(window.localStorage); } catch { /* private mode */ }
}
