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
// The pending-redirect marker lives in localStorage, not sessionStorage. An
// installed PWA can be killed while Google's account chooser is open, and the
// callback can land in another browsing context; a per-tab marker would make
// completion depend on storage the platform is free to clear. The marker only
// says "an attempt exists" — the sign-in itself is Firebase's trusted state.
const PENDING_REDIRECT = 'leroutier:auth-redirect';
const FIREBASE_APP_NAME = 'leroutier-auth';

// ONE authoritative production auth origin. The Vercel domain setup may serve
// the app on the apex or on www (a platform redirect can bounce between the
// two), but OAuth must always return to the single handler registered with
// Google Cloud: https://leroutier.app/__/auth/handler. Pinning the apex makes
// every branded host converge on it — and the apex→www hop, while it exists,
// is a 308 that preserves the callback query exactly.
const BRANDED_AUTH_HOSTS = new Set(['leroutier.app', 'www.leroutier.app']);
const BRANDED_AUTH_ORIGIN = 'leroutier.app';

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
    if (value) return safeReturnPath(value);
  } catch { /* private mode */ }
  return '/';
}

// ------------------------------------------------------- redirect marker ----

/**
 * The redirect marker: durable across PWA relaunches, and read/cleared through
 * these helpers so every consumer agrees on its shape. Its return path is a
 * convenience for landing back where the user was — never a security gate.
 */
export function readRedirectMarker(/** @type {Storage|undefined} */ storage = globalThis.window?.localStorage) {
  try {
    const raw = storage?.getItem(PENDING_REDIRECT);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? { returnTo: safeReturnPath(parsed.returnTo) } : null;
  } catch { return null; }
}
export function writeRedirectMarker(returnTo, /** @type {Storage|undefined} */ storage = globalThis.window?.localStorage) {
  try { storage?.setItem(PENDING_REDIRECT, JSON.stringify({ returnTo: safeReturnPath(returnTo) })); } catch { /* private mode */ }
}
export function clearRedirectMarker(/** @type {Storage|undefined} */ storage = globalThis.window?.localStorage) {
  try { storage?.removeItem(PENDING_REDIRECT); } catch { /* private mode */ }
}

/**
 * The production PWA deliberately serves Firebase's helper routes through the
 * LeRoutier origin. Firebase recommends this reverse-proxy pattern for apps
 * hosted outside Firebase Hosting because it keeps the auth helper same-origin
 * and avoids third-party-storage failures. It also means the account chooser
 * is branded with LeRoutier's domain instead of *.firebaseapp.com.
 *
 * Every branded host returns the SAME apex origin (see BRANDED_AUTH_ORIGIN):
 * the OAuth callback is registered with Google for exactly one redirect URI,
 * and mirroring the serving hostname would produce a second, unregistered one.
 *
 * Local development keeps the configured Firebase domain because localhost
 * does not proxy /__/auth to the Firebase project.
 */
export function browserAuthDomain(config, /** @type {{hostname?: string}|undefined} */ location = globalThis.window?.location) {
  const hostname = String(location?.hostname || '').toLowerCase();
  return BRANDED_AUTH_HOSTS.has(hostname) ? BRANDED_AUTH_ORIGIN : config?.authDomain;
}

/** What a provider failure means in product language. */
export function signInFailure(error, during = 'popup') {
  const code = String(error?.code ?? '');
  const fail = (message, retryable) =>
    Object.assign(new Error(message, { cause: error }), { reason: code || 'unknown', retryable });
  switch (code) {
  case 'auth/popup-closed-by-user':
  case 'auth/user-cancelled':
    return fail('Connexion annulée.', true);
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
  case 'auth/redirect-cancelled-by-user':
    return fail('Connexion annulée.', true);
  case 'auth/popup-blocked':
    return fail('La fenêtre de connexion a été bloquée par le navigateur. Autorisez les fenêtres pour ce site, puis réessayez.', true);
  case 'auth/redirect-incomplete':
    // The app returned from the provider without a usable result — the person
    // cancelled in the chooser, or the installed app was suspended mid-flow and
    // the credential could not be recovered. One honest message, one retry.
    return fail('La connexion Google n’a pas abouti. Réessayez.', true);
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
let initializing = null;
let googleSignInInFlight = null;

export async function firebaseAuth(config) {
  if (!config?.apiKey || !config?.authDomain || !config?.projectId || !config?.appId) return null;
  const authDomain = browserAuthDomain(config);
  if (!authDomain) return null;
  const key = `${config.projectId}:${config.appId}:${authDomain}`;
  if (cached?.key === key) return cached;
  // One initialization at a time: config fetch, redirect completion and the
  // auth-state subscription all call this on mount, and each of them must see
  // the same instance, with persistence set exactly once.
  if (initializing) return initializing;

  initializing = (async () => {
    const [{ initializeApp, getApps, deleteApp }, auth] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
    ]);

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
    // A phone app is expected to stay signed in when it is closed and reopened.
    // Firebase local persistence stores the provider session on this browser/PWA
    // only; explicit sign-out still removes it and also clears queued crew codes.
    // Fall back only when the browser refuses durable storage (for example some
    // private modes), rather than deliberately logging everyone out on app close.
    await auth.setPersistence(instance, auth.browserLocalPersistence)
      .catch(() => auth.setPersistence(instance, auth.browserSessionPersistence))
      .catch(() => auth.setPersistence(instance, auth.inMemoryPersistence));
    cached = { key, auth: instance, sdk: auth };
    return cached;
  })();
  try { return await initializing; }
  finally { initializing = null; }
}

export function preferGoogleRedirect() {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    // The UA-data shape varies by browser and by TS lib version; read the
    // mobile flag defensively and fall back to the user-agent string.
    const uaData = /** @type {{mobile?: boolean}|undefined} */ (navigator.userAgentData);
    if (uaData?.mobile === true) return true;
  } catch { /* older browsers */ }
  return /Android|iPhone|iPad|iPod|Mobile/i.test(String(globalThis.navigator?.userAgent || ''));
}

async function beginGoogleRedirect(sdk, auth, provider, returnTo) {
  // Written before the attempt and cleared only once the result is consumed
  // (or the attempt has provably ended). Durable so a PWA relaunch can still
  // complete the flow it started.
  writeRedirectMarker(returnTo);
  try {
    await sdk.signInWithRedirect(auth, provider);
    return null;
  } catch (error) {
    clearRedirectMarker();
    throw signInFailure(error, 'redirect');
  }
}

async function performGoogleSignIn(config, returnTo) {
  const ready = await firebaseAuth(config);
  if (!ready) throw new Error('auth-unavailable');
  const { sdk, auth } = ready;

  const provider = new sdk.GoogleAuthProvider();
  provider.addScope('openid');
  provider.addScope('profile');
  provider.addScope('email');

  rememberReturnPath(returnTo);

  // Mobile browsers and installed PWAs are where popup auth is least reliable:
  // popup blockers, browser-to-PWA handoff and process suspension can all leave
  // the person back on the login screen. Use the redirect directly there.
  // Desktop keeps the faster popup flow.
  if (preferGoogleRedirect()) return beginGoogleRedirect(sdk, auth, provider, returnTo);

  try {
    const result = await sdk.signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    const code = error?.code ?? '';
    if (code === 'auth/cancelled-popup-request') return null;
    if (code === 'auth/popup-closed-by-user') throw signInFailure(error);
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(code)) {
      return beginGoogleRedirect(sdk, auth, provider, returnTo);
    }
    throw signInFailure(error);
  }
}

/**
 * Starts one Google sign-in at a time. Fast taps used to create overlapping
 * Firebase popup requests; the first was cancelled while the UI became usable
 * again, which made people press the button repeatedly. Every caller now joins
 * the same in-flight attempt.
 */
export async function signInWithGoogle(config, returnTo = '/') {
  if (googleSignInInFlight) return googleSignInInFlight;
  googleSignInInFlight = performGoogleSignIn(config, returnTo);
  try { return await googleSignInInFlight; }
  finally { googleSignInInFlight = null; }
}

/**
 * Consumes a redirect sign-in the app started earlier — possibly in a previous
 * life of this PWA process. Returns null when no attempt is pending; otherwise
 * {user, returnTo} on success (the user may be a restored session when the
 * credential was already consumed on an earlier load), or {user:null, error}
 * with a product-language explanation.
 */
export async function completeRedirectSignIn(config) {
  const marker = readRedirectMarker();
  if (!marker) return null;
  const ready = await firebaseAuth(config);
  if (!ready) {
    // Firebase cannot start right now, but the credential may still be waiting
    // for a later load. Keep the marker and say so.
    return { user: null, error: signInFailure(new Error('auth-unavailable'), 'redirect'), returnTo: marker.returnTo };
  }
  const { sdk, auth } = ready;
  try {
    const result = await sdk.getRedirectResult(auth);
    if (result?.user) {
      clearRedirectMarker();
      return { user: result.user, error: null, returnTo: marker.returnTo };
    }
    // A null result can still mean success: the credential was consumed on an
    // earlier load and the user simply restored from local persistence. Trust
    // Firebase's auth state, not our marker.
    if (auth.currentUser) {
      clearRedirectMarker();
      return { user: auth.currentUser, error: null, returnTo: marker.returnTo, restored: true };
    }
    // No result and no user: the attempt ended without a sign-in (cancelled in
    // the chooser, or the PWA process lost the redirect state). The attempt is
    // over — clear it and let one tap start a clean one.
    clearRedirectMarker();
    return { user: null, error: signInFailure(Object.assign(new Error('redirect incomplete'), { code: 'auth/redirect-incomplete' }), 'redirect'), returnTo: marker.returnTo };
  } catch (error) {
    // A transport failure leaves Firebase's own pending-redirect state in
    // place; keep the marker so the next app load retries consuming it
    // instead of discarding a recoverable sign-in.
    return { user: null, error: signInFailure(error, 'redirect'), returnTo: marker.returnTo };
  }
}

export async function idToken(config, { force = false } = {}) {
  const ready = await firebaseAuth(config);
  const user = ready?.auth?.currentUser;
  return user ? user.getIdToken(force) : null;
}

export async function onAuthChange(config, callback) {
  const ready = await firebaseAuth(config);
  if (!ready) return () => {};
  return ready.sdk.onAuthStateChanged(ready.auth, callback);
}

export async function createAccountWithEmail(config, { email, password }) {
  const ready = await firebaseAuth(config);
  if (!ready) throw new Error('auth-unavailable');
  try { return await ready.sdk.createUserWithEmailAndPassword(ready.auth, String(email).trim(), String(password)); }
  catch (error) { throw signInFailure(error, 'password'); }
}

export async function signInWithEmail(config, { email, password }) {
  const ready = await firebaseAuth(config);
  if (!ready) throw new Error('auth-unavailable');
  try { return await ready.sdk.signInWithEmailAndPassword(ready.auth, String(email).trim(), String(password)); }
  catch (error) { throw signInFailure(error, 'password'); }
}

export async function sendPasswordReset(config, email) {
  const ready = await firebaseAuth(config);
  if (!ready) throw new Error('auth-unavailable');
  await ready.sdk.sendPasswordResetEmail(ready.auth, String(email).trim());
}

export async function signOutFirebase(config) {
  const ready = await firebaseAuth(config);
  if (ready) await ready.sdk.signOut(ready.auth).catch(() => {});
  try { window.sessionStorage.removeItem(RETURN_TO); } catch { /* private mode */ }
  clearRedirectMarker();
  try { clearQueuedActions(window.localStorage); } catch { /* private mode */ }
}
