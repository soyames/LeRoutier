/**
 * Registration capacity protection.
 *
 * LeRoutier runs on a bounded Neon PostgreSQL allowance. Running that
 * allowance to zero does not degrade gracefully: it stops bookings, tickets,
 * parcels and payments for every existing user at once. So the *cheapest*
 * thing the platform can refuse — creating a brand new account — is refused
 * first, well before the database is actually full.
 *
 * The rules, deliberately narrow:
 *
 *   - An existing identity ALWAYS authenticates. Capacity never locks anyone
 *     out of an account they already have; a suspended account is a separate
 *     decision made by `activeIdentity`.
 *   - Only the creation of a NEW identity is gated.
 *   - Nothing else is gated. Bookings, payments, tickets, parcels and crew
 *     operations keep working after registration closes — that is the whole
 *     point of closing registration early.
 *
 * The check is a real measurement (`pg_database_size`) taken inside the same
 * transaction that would insert the user, behind a transaction-scoped
 * advisory lock, so a burst of concurrent first sign-ins cannot each observe
 * "83%" and collectively land at 110%.
 */
import { invariant } from '@leroutier/domain';

/** Advisory-lock key shared by every registration attempt. */
export const REGISTRATION_LOCK = 'registration:capacity';

/**
 * Environment-driven policy. Read per call rather than captured at module
 * load so a redeploy-free environment change (Vercel) takes effect on the
 * next invocation instead of on the next cold start.
 */
export function registrationPolicy(env = process.env) {
  const limitMb = Number(env.DATABASE_STORAGE_LIMIT_MB);
  const stopPercent = Number(env.REGISTRATION_STORAGE_STOP_PERCENT);
  return {
    limitBytes: Number.isFinite(limitMb) && limitMb > 0 ? Math.round(limitMb * 1024 * 1024) : null,
    // 85% by default; values outside a sane band are ignored rather than
    // trusted, so a typo cannot disable the protection or close the door at 1%.
    threshold: Number.isFinite(stopPercent) && stopPercent >= 50 && stopPercent <= 99 ? stopPercent : 85,
    // The only kill switch. Anything other than the exact string 'false'
    // leaves registration enabled: fail-open on a typo here is correct,
    // because the storage threshold is the real protection.
    registrationEnabled: env.REGISTRATION_ENABLED !== 'false',
  };
}

/**
 * Measure the database and decide whether a new account may be created.
 * Read-only: safe to call from Platform Ops health as well as from the gate.
 * @param {{query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>}} tx
 */
export async function registrationCapacity(tx, env = process.env) {
  const policy = registrationPolicy(env);
  const row = (await tx.query('SELECT pg_database_size(current_database())::bigint AS bytes')).rows[0];
  const usedBytes = Number(row?.bytes ?? 0);
  const usedPercent = policy.limitBytes ? Math.round((usedBytes / policy.limitBytes) * 1000) / 10 : null;
  const open = policy.registrationEnabled && (usedPercent === null || usedPercent < policy.threshold);
  return {
    usedBytes,
    limitBytes: policy.limitBytes,
    usedPercent,
    registrationStopPercent: policy.threshold,
    registrationEnabled: policy.registrationEnabled,
    registrationsOpen: open,
    // Whether the storage gate can actually fire.
    //
    // Without DATABASE_STORAGE_LIMIT_MB there is nothing to measure against,
    // so `registrationsOpen` is true for the same reason an unplugged smoke
    // alarm is silent. Platform Ops was shown that as a green "capacity
    // available", which is the worst way to report a protection that is not
    // running: the one screen meant to warn about it confirmed the opposite.
    // Said out loud here so no console has to infer it from a null.
    storageProtection: policy.limitBytes ? 'armed' : 'not_configured',
    // Why it is closed, for Platform Ops only. Never sent to the public.
    reason: open ? null : policy.registrationEnabled ? 'storage' : 'disabled',
  };
}

/**
 * Gate the creation of a new identity. Call INSIDE the transaction that would
 * create the user, before the insert.
 *
 * The refusal is deliberately opaque: a visitor is told registration is
 * paused, never how full the database is. Capacity numbers are Platform Ops
 * information and stay there.
 */
export async function assertRegistrationOpen(tx, env = process.env) {
  // Transaction-scoped: released with the transaction, whether it commits or
  // rolls back. Serializes the measurement with every other registration.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [REGISTRATION_LOCK]);
  const capacity = await registrationCapacity(tx, env);
  invariant(capacity.registrationsOpen, 'REGISTRATION_SUSPENDED',
    'Les nouvelles inscriptions LeRoutier sont momentanément suspendues. Les comptes existants ne sont pas affectés.', 503);
  return capacity;
}
