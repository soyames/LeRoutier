// Firebase identity administration, server-only.
//
// The browser SDK (packages/config/firebase.js) obtains ID tokens; this module
// acts AS LeRoutier on the Firebase project: minting email-verification action
// links and deleting the authentication identity when an account deletion
// actually executes. It must never be imported by anything the browser loads —
// the repository's secret scan fails any bundle containing firebase-admin, and
// that is the point: the service-account credential gives full project control.
//
// Credentials come from exactly one of:
//   FIREBASE_ADMIN_SERVICE_ACCOUNT   a service-account JSON in one env var
//   GOOGLE_APPLICATION_CREDENTIALS   a path to a service-account JSON file
// ...parsed defensively. A malformed value disables the capability instead of
// crashing the process, and nothing here logs the credential or anything
// derived from it. The deployment's configuration decides availability;
// callers fail closed when it is missing.
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const REQUIRED_FIELDS = ['project_id', 'client_email', 'private_key'];

function parseServiceAccount(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || value.type !== 'service_account') return null;
    if (!REQUIRED_FIELDS.every(key => typeof value[key] === 'string' && value[key].length > 0)) return null;
    return value;
  } catch {
    return null;
  }
}

function resolveServiceAccount(config) {
  const fromEnv = parseServiceAccount(config.firebaseAdminServiceAccount);
  if (fromEnv) return fromEnv;
  const path = config.googleApplicationCredentials;
  if (typeof path === 'string' && path.trim()) {
    try { return parseServiceAccount(readFileSync(path.trim(), 'utf8')); } catch { /* unreadable file disables the capability */ }
  }
  return null;
}

/**
 * The Firebase Admin surface LeRoutier uses. `client` is injectable for tests
 * (same method names as the real Auth object); production wires the Admin SDK
 * with the resolved service account. Provider calls are never made inside a
 * database transaction — callers own that ordering — and a provider failure is
 * a thrown error the caller retries, never a false claim of success.
 *
 * @param {{firebaseAdminServiceAccount?:string|null,googleApplicationCredentials?:string|null}} [config]
 * @param {{generateEmailVerificationLink?:Function,deleteUser?:Function,getUser?:Function}|null} [client]
 */
export function createFirebaseAdmin(config = {}, client = null) {
  const serviceAccount = client ? null : resolveServiceAccount(config);
  let app = null;
  async function admin() {
    if (!app) app = initializeApp({ credential: cert(serviceAccount) }, 'leroutier-admin');
    return getAuth(app);
  }
  const available = client ? true : serviceAccount !== null;
  return {
    /** Whether a usable credential exists. Callers fail closed when false. */
    get available() { return available; },
    /**
     * Generate Firebase's real one-time verification code, but do not send the
     * provider-hosted action URL to the passenger. Admin SDK action links point
     * at Firebase's handler and carry LeRoutier only as a continue URL; sending
     * that link directly would let Firebase consume the code first and then
     * return to /verify-email without the oobCode our branded page needs.
     *
     * Instead, extract the trusted oobCode from Firebase's generated URL and
     * place it on the LeRoutier verification route. The browser still applies
     * the code with Firebase's supported applyActionCode API, but the user sees
     * leroutier.app from the email click onward.
     */
    async generateEmailVerificationLink(email, continueUrl) {
      const raw = await (client ?? await admin()).generateEmailVerificationLink(email, { url: continueUrl });
      const action = new URL(raw);
      const code = action.searchParams.get('oobCode');
      if (!code) throw new Error('Firebase verification link did not contain an action code.');
      const branded = new URL(continueUrl);
      branded.searchParams.set('mode', 'verifyEmail');
      branded.searchParams.set('oobCode', code);
      return branded.toString();
    },
    /**
     * Deletes the Firebase Authentication identity. `not_found` is the
     * idempotent success case: the identity is already gone, which is exactly
     * the intended end state, so a retry after a crash completes normally.
     */
    async deleteUser(uid) {
      try { await (client ?? await admin()).deleteUser(uid); return { status: 'deleted' }; }
      catch (error) {
        if (error?.code === 'auth/user-not-found') return { status: 'not_found' };
        throw error;
      }
    },
    /** Look an identity up safely: null when it does not exist, errors rethrown. */
    async getUser(uid) {
      try { return await (client ?? await admin()).getUser(uid); }
      catch (error) { if (error?.code === 'auth/user-not-found') return null; throw error; }
    },
  };
}
