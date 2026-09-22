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

/**
 * What a provider failure means, in the product's language.
 *
 * One place interprets Firebase error codes, because the alternative is what
 * this replaced: a little mapping at each call site, each knowing about a
 * different two or three codes, and everything else collapsing into "réessayez"
 * — including the failures where retrying can never work.
 *
 * `retryable` is the honest part. An unauthorized domain, a disabled provider
 * and an account collision are configuration or account facts: telling somebody
 * to try again sends them round a loop that has no exit. The provider's own
 * message is never shown — it is developer-facing and names internals — but it
 * is kept as the `cause` for diagnosis.
 *
 * @param {any} error
 * @param {'popup'|'redirect'|'password'} [during]
 */
export function signInFailure(error, during = 'popup') {
  const code = String(error?.code ?? '');
  const fail = (message, retryable) =>
    Object.assign(new Error(message, { cause: error }), { reason: code || 'unknown', retryable });
  switch (code) {
  case 'auth/popup-closed-by-user':
  case 'auth/user-cancelled':
    return fail('Connexion annulée.', true);
  // Configuration, not bad luck. This is the failure a branded auth domain
  // introduces: the host must be an authorized domain on the Firebase project,
  // and until somebody adds it no amount of retrying helps.
  case 'auth/unauthorized-domain':
  case 'auth/operation-not-allowed':
  case 'auth/invalid-api-key':
  case 'auth/api-key-not-valid-please-pass-a-valid-api-key':
    return fail('La connexion Google n’est pas disponible sur cette adresse. Signalez-le à LeRoutier.', false);
  case 'auth/account-exists-with-different-credential':
    return fail('Un compte existe déjà avec cette adresse e-mail. Connectez-vous avec votre mot de passe.', false);
  case 'auth/user-disabled':
    return fail('Ce compte est désactivé. Contactez LeRoutier.', false);
  case 'auth/network-request-failed':
    return fail('Connexion au service d’identité impossible. Vérifiez votre réseau puis réessayez.', true);
  case 'auth/too-many-requests':
    return fail('Trop de tentatives. Patientez un instant.', true);
  case 'auth/invalid-credential':
  case 'auth/wrong-password':
  case 'auth/user-not-found':
    return fail('Adresse e-mail ou mot de passe incorrect.', true);
  case 'auth/email-already-in-use':
    return fail('Cette adresse e-mail possède déjà un compte. Connectez-vous.', false);
  case 'auth/weak-password':
    return fail('Choisissez un mot de passe d’au moins six caractères.', true);
  case 'auth/invalid-email':
    return fail('Cette adresse e-mail n’est pas valide.', true);
  default:
    return fail(during === 'password'
      ? 'Impossible de vous connecter. Réessayez.'
      : 'Impossible de démarrer la connexion. Réessayez.', true);
  }
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
    // A superseded popup request. The user clicked twice and the SECOND popup
    // is still open and still working: this rejection belongs to the first
    // call. Falling back to a redirect here navigated the page away and killed
    // the live popup, turning a double click into a failed sign-in.
    if (code === 'auth/cancelled-popup-request') return null;
    // Closing the window is a decision, not an obstacle to route around.
    if (code === 'auth/popup-closed-by-user') throw signInFailure(error);
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(code)) {
      try { window.sessionStorage.setItem(PENDING_REDIRECT, '1'); } catch { /* private mode */ }
      try {
        await sdk.signInWithRedirect(auth, provider);
      } catch (redirectError) {
        // The redirect never started, so nothing will come back to finish it.
        try { window.sessionStorage.removeItem(PENDING_REDIRECT); } catch { /* private mode */ }
        throw signInFailure(redirectError, 'redirect');
      }
      // The page navigates away; nothing after this runs.
      return null;
    }
    throw signInFailure(error);
  }
}

/**
 * Completes a redirect sign-in, if one is in flight.
 *
 * Called once on load. It asks Firebase only when a redirect was actually
 * started, so a normal visit costs nothing.
 *
 * A failure here is REPORTED rather than swallowed. This used to return null on
 * any error, which meant a person who clicked "Continuer avec Google", was sent
 * to Google, and came back to a page that looked exactly as they had left it —
 * signed out, with no explanation and nothing to act on. The redirect path is
 * the mobile path, so that silence fell on the users least able to work around
 * it.
 *
 * @returns {Promise<{user: any, error: null} | {user: null, error: Error} | null>}
 *   null when no redirect was in flight.
 */
export async function completeRedirectSignIn(config) {
  let pending = false;
  try { pending = window.sessionStorage.getItem(PENDING_REDIRECT) === '1'; } catch { /* private mode */ }
  if (!pending) return null;
  try { window.sessionStorage.removeItem(PENDING_REDIRECT); } catch { /* private mode */ }
  const ready = await firebaseAuth(config);
  if (!ready) return { user: null, error: signInFailure(new Error('auth-unavailable'), 'redirect') };
  try {
    const result = await ready.sdk.getRedirectResult(ready.auth);
    // No result means the redirect completed without a credential — the user
    // backed out at Google. That is a cancellation, not a failure to report.
    return result?.user ? { user: result.user, error: null } : null;
  } catch (error) {
    return { user: null, error: signInFailure(error, 'redirect') };
  }
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
  try { return await ready.sdk.createUserWithEmailAndPassword(ready.auth, String(email).trim(), String(password)); }
  catch (error) { throw signInFailure(error, 'password'); }
}

/** Email/password sign-in; the same single-identity model as Google. */
export async function signInWithEmail(config, { email, password }) {
  const ready = await firebaseAuth(config);
  if (!ready) throw new Error('auth-unavailable');
  try { return await ready.sdk.signInWithEmailAndPassword(ready.auth, String(email).trim(), String(password)); }
  catch (error) { throw signInFailure(error, 'password'); }
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
