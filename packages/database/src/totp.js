// Time-based one-time passwords (RFC 6238), implemented here rather than
// bought. See migration 039 for why: Firebase's own MFA needs Identity
// Platform, which is a paid product, and this deployment runs on the free tier
// by owner constraint. The algorithm is HMAC over a shared secret and the
// current time step — no vendor, no network, no billing.
//
// The pure functions are exported for the tests, which check them against the
// RFC's own published vectors. Everything that touches state lives on the
// service, which owns the transaction boundaries.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { invariant } from '@leroutier/domain';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
// One step either side of now. Every authenticator app assumes this much clock
// drift, and refusing it would fail a correct code on a phone a few seconds
// out — which reads to the user as "the feature is broken".
const WINDOW = 1;
const SECRET_BYTES = 20; // 160 bits, the size RFC 4226 recommends for HMAC-SHA1
const RECOVERY_CODE_COUNT = 10;
// How long a browser stays "already proved the factor". Long enough not to
// demand a code on every visit, short enough that a shared handset does not
// stay trusted for a season.
const SESSION_DAYS = 30;

/** RFC 4648 base32, unpadded — the encoding every authenticator app expects. */
export function base32Encode(buffer) {
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Throws on anything that is not unpadded base32 — never guesses. */
export function base32Decode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  invariant(clean.length > 0 && /^[A-Z2-7]+$/.test(clean), 'TOTP_INVALID', 'This secret is not valid.', 400);
  let bits = 0, value = 0;
  const bytes = [];
  for (const character of clean) {
    value = (value << 5) | ALPHABET.indexOf(character); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

/** RFC 4226: HMAC-SHA1, dynamic truncation, `digits` decimal digits. */
export function hotp(secret, counter, digits = DIGITS) {
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code for the step containing `atSeconds`. */
export const totpAt = (secret, atSeconds, step = STEP_SECONDS) => hotp(secret, Math.floor(atSeconds / step));

/** The step number containing `atSeconds` — what replay protection records. */
export const stepAt = (atSeconds, step = STEP_SECONDS) => Math.floor(atSeconds / step);

/**
 * The step whose code this is, or null. Returns the STEP rather than a
 * boolean so the caller can reject a step it has already accepted: a code seen
 * over a shoulder must not keep working for the rest of its window.
 *
 * Comparison is constant-time. A code is only six digits, so a timing signal
 * is a real shortcut to guessing one.
 */
export function matchingStep(secret, code, atSeconds, { window = WINDOW, step = STEP_SECONDS } = {}) {
  const candidate = String(code ?? '').trim();
  if (!/^\d{6}$/.test(candidate)) return null;
  const centre = stepAt(atSeconds, step);
  for (let offset = -window; offset <= window; offset++) {
    const counter = centre + offset;
    if (counter < 0) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, counter)), Buffer.from(candidate))) return counter;
  }
  return null;
}

/** A fresh shared secret, and the URI an authenticator app reads as a QR code. */
export function newSecret(issuer, account) {
  const secret = base32Encode(randomBytes(SECRET_BYTES));
  return { secret, uri: otpauthUri({ issuer, account, secret }) };
}

export function otpauthUri({ issuer, account, secret, digits = DIGITS, step = STEP_SECONDS }) {
  const label = encodeURIComponent(`${issuer}:${account}`.replace(/:/g, ':'));
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(step) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const hashOf = value => createHash('sha256').update(String(value)).digest('hex');

/** Human-transcribable single-use codes: 10 characters, grouped. */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(8)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

// Recovery codes are meant to be read off paper and typed, so the dash and
// case are presentation. Accepting either keeps that promise instead of
// failing somebody for typing what they were shown.
const normaliseRecovery = value => String(value ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');

/**
 * A second factor for one identity.
 *
 * Every method takes the identity id the API resolved from a VERIFIED token —
 * never a user id from the request — so there is no path here that reads or
 * writes another account's factor.
 */
export function totpService(db, { clock = () => Date.now() / 1000 } = {}) {
  const now = clock;

  async function row(tx, userId) {
    return (await tx.query('SELECT user_id,secret,confirmed_at,last_step FROM user_totp WHERE user_id=$1', [userId])).rows[0] ?? null;
  }

  /** Whether the factor is on, and how many recovery codes are left. */
  async function status(userId) {
    return db.transaction(async tx => {
      const stored = await row(tx, userId);
      if (!stored) return { enabled: false, confirmedAt: null, recoveryCodesRemaining: 0 };
      const remaining = stored.confirmed_at
        ? (await tx.query('SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [userId])).rows[0].n
        : 0;
      return { enabled: stored.confirmed_at !== null, confirmedAt: stored.confirmed_at, recoveryCodesRemaining: remaining };
    });
  }

  /**
   * Starts (or restarts) enrolment. The secret is stored but NOT confirmed, so
   * it gates nothing until a code proves the authenticator received it — an
   * abandoned enrolment must never be able to lock someone out.
   *
   * Restarting is allowed and is why the row is replaced rather than inserted:
   * a user whose QR code never scanned needs to be able to ask again.
   */
  async function beginEnrolment(userId, account) {
    invariant(typeof account === 'string' && account.length > 0, 'UNAUTHORIZED', 'Sign in to continue.', 401);
    const { secret, uri } = newSecret('LeRoutier', account);
    const enabled = await db.transaction(async tx => {
      const stored = await row(tx, userId);
      invariant(!stored?.confirmed_at, 'TOTP_ALREADY_ENABLED', 'La double authentification est déjà activée sur ce compte.', 409);
      await tx.query(`INSERT INTO user_totp(user_id,secret,confirmed_at,last_step) VALUES($1,$2,NULL,NULL)
        ON CONFLICT(user_id) DO UPDATE SET secret=EXCLUDED.secret, confirmed_at=NULL, last_step=NULL, updated_at=now()`, [userId, secret]);
      return false;
    });
    return { secret, uri, enabled };
  }

  /**
   * Confirms enrolment with a code from the app, and returns the recovery
   * codes. They are returned exactly once, here: only their hashes are stored,
   * so there is no second chance to read them and the UI has to say so.
   */
  async function activate(userId, code) {
    return db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const stored = await row(tx, userId);
      invariant(stored, 'TOTP_NOT_STARTED', 'Commencez l’activation avant de saisir un code.', 409);
      invariant(!stored.confirmed_at, 'TOTP_ALREADY_ENABLED', 'La double authentification est déjà activée sur ce compte.', 409);
      const step = matchingStep(stored.secret, code, now());
      invariant(step !== null, 'TOTP_INVALID', 'Ce code n’est pas valide. Vérifiez l’heure de votre téléphone et réessayez.', 403);
      await tx.query('UPDATE user_totp SET confirmed_at=now(), last_step=$2, updated_at=now() WHERE user_id=$1', [userId, step]);
      await tx.query('DELETE FROM user_recovery_codes WHERE user_id=$1', [userId]);
      const codes = newRecoveryCodes();
      for (const value of codes) {
        await tx.query('INSERT INTO user_recovery_codes(user_id,code_hash) VALUES($1,$2)', [userId, hashOf(normaliseRecovery(value))]);
      }
      return { recoveryCodes: codes };
    });
  }

  /**
   * Turns the factor off. It requires a current code: without that, anybody who
   * got hold of an unlocked signed-in phone could simply remove the protection,
   * which is the whole thing the factor exists to prevent.
   */
  async function disable(userId, code) {
    return db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const stored = await row(tx, userId);
      invariant(stored?.confirmed_at, 'TOTP_NOT_ENABLED', 'La double authentification n’est pas activée sur ce compte.', 409);
      const step = matchingStep(stored.secret, code, now());
      invariant(step !== null, 'TOTP_INVALID', 'Ce code n’est pas valide. Vérifiez l’heure de votre téléphone et réessayez.', 403);
      // The same replay rule as verify: removing the factor is exactly as
      // sensitive as using it, so a code already spent cannot do it either.
      invariant(stored.last_step === null || step > stored.last_step, 'TOTP_REPLAYED',
        'Ce code a déjà été utilisé. Attendez le suivant.', 403);
      await tx.query('DELETE FROM user_totp WHERE user_id=$1', [userId]);
      await tx.query('DELETE FROM user_recovery_codes WHERE user_id=$1', [userId]);
      // Every browser that had passed the factor is signed back out of the
      // step-up, because the factor those sessions were granted for is gone.
      await tx.query('DELETE FROM totp_sessions WHERE user_id=$1', [userId]);
      return { enabled: false };
    });
  }

  /** Issues a step-up token, so this browser stops being asked for a code. */
  async function grant(userId) {
    const token = randomBytes(32).toString('base64url');
    return db.transaction(async tx => {
      await tx.query('DELETE FROM totp_sessions WHERE user_id=$1 AND expires_at < now()', [userId]);
      await tx.query(`INSERT INTO totp_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3 || ' days')::interval)`,
        [hashOf(token), userId, String(SESSION_DAYS)]);
      return { token, expiresInDays: SESSION_DAYS };
    });
  }

  /**
   * Proves the factor during sign-in: a live authenticator code, or one unused
   * recovery code. Both are consumed under the same lock as the enrolment, so
   * two simultaneous attempts cannot both spend the last one.
   */
  async function verify(userId, code) {
    const result = await db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const stored = await row(tx, userId);
      invariant(stored?.confirmed_at, 'TOTP_NOT_ENABLED', 'La double authentification n’est pas activée sur ce compte.', 409);
      const at = now();
      const step = matchingStep(stored.secret, code, at);
      if (step !== null) {
        // Replay guard: a step already spent is refused even inside its window.
        invariant(stored.last_step === null || step > stored.last_step, 'TOTP_REPLAYED',
          'Ce code a déjà été utilisé. Attendez le suivant.', 403);
        await tx.query('UPDATE user_totp SET last_step=$2, updated_at=now() WHERE user_id=$1', [userId, step]);
        return { ok: true, method: 'totp' };
      }
      const candidate = normaliseRecovery(code);
      invariant(candidate.length > 0, 'TOTP_INVALID', 'Ce code n’est pas valide.', 403);
      const spent = await tx.query(`UPDATE user_recovery_codes SET used_at=now()
        WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id`, [userId, hashOf(candidate)]);
      invariant(spent.rows.length === 1, 'TOTP_INVALID', 'Ce code n’est pas valide.', 403);
      return { ok: true, method: 'recovery' };
    });
    // A recovery code is single-use, so it is treated as loud: the remaining
    // count is part of the answer, and the UI warns when they run low.
    const remaining = (await db.transaction(async tx =>
      (await tx.query('SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [userId])).rows[0].n));
    return { ...result, recoveryCodesRemaining: remaining };
  }

  /** Whether this browser has already passed the factor. Never throws. */
  async function hasSession(userId, token) {
    if (typeof token !== 'string' || !token) return false;
    return db.transaction(async tx => {
      const live = (await tx.query(`SELECT token_hash FROM totp_sessions
        WHERE token_hash=$1 AND user_id=$2 AND expires_at > now()`, [hashOf(token), userId])).rows[0];
      if (!live) return false;
      // Refreshed lazily: this runs on every authenticated request, and writing
      // the same row every time would cost an update per API call for a value
      // nothing reads more precisely than "recently".
      await tx.query(`UPDATE totp_sessions SET last_seen_at=now() WHERE token_hash=$1
        AND last_seen_at < now()-interval '1 hour'`, [hashOf(token)]);
      return true;
    });
  }

  /** Ends every granted session for this identity — a global sign-out. */
  async function revokeAll(userId) {
    return db.transaction(async tx => (await tx.query('DELETE FROM totp_sessions WHERE user_id=$1 RETURNING token_hash', [userId])).rows.length);
  }

  return { status, beginEnrolment, activate, disable, verify, grant, hasSession, revokeAll, sessionDays: SESSION_DAYS };
}
