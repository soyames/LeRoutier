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
 */
export function browserAuthDomain(config, location = globalThis.window?.location) {
  const hostname = String(location?.hostname || '').toLowerCase();
  return BRANDED_AUTH_HOSTS.has(hostname) ? hostname : config?.authDomain;
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
let googleSignInInFlight = null;

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
}

function preferGoogleRedirect() {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    if (navigator.userAgentData?.mobile === true) return true;
  } catch { /* older browsers */ }
  return /Android|iPhone|iPad|iPod|Mobile/i.test(String(globalThis.navigator?.userAgent || ''));
}

async function beginGoogleRedirect(sdk, auth, provider) {
  try { window.sessionStorage.setItem(PENDING_REDIRECT, '1'); } catch { /* private mode */ }
  try {
    await sdk.signInWithRedirect(auth, provider);
    return null;
  } catch (error) {
    try { window.sessionStorage.removeItem(PENDING_REDIRECT); } catch { /* private mode */ }
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
  // the person back on the login screen. Use the same-origin redirect directly
  // there. Desktop keeps the faster popup flow.
  if (preferGoogleRedirect()) return beginGoogleRedirect(sdk, auth, provider);

  try {
    const result = await sdk.signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    const code = error?.code ?? '';
    if (code === 'auth/cancelled-popup-request') return null;
    if (code === 'auth/popup-closed-by-user') throw signInFailure(error);
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(code)) {
      return beginGoogleRedirect(sdk, auth, provider);
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

export async function completeRedirectSignIn(config) {
  let pending = false;
  try { pending = window.sessionStorage.getItem(PENDING_REDIRECT) === '1'; } catch { /* private mode */ }
  if (!pending) return null;
  try { window.sessionStorage.removeItem(PENDING_REDIRECT); } catch { /* private mode */ }
  const ready = await firebaseAuth(config);
  if (!ready) return { user: null, error: signInFailure(new Error('auth-unavailable'), 'redirect') };
  try {
    const result = await ready.sdk.getRedirectResult(ready.auth);
    return result?.user ? { user: result.user, error: null } : null;
  } catch (error) {
    return { user: null, error: signInFailure(error, 'redirect') };
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
  try {
    window.sessionStorage.removeItem(RETURN_TO);
    window.sessionStorage.removeItem(PENDING_REDIRECT);
  } catch { /* private mode */ }
  try { clearQueuedActions(window.localStorage); } catch { /* private mode */ }
}
