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
 * The hard limit the DATABASE ITSELF enforces, when it publishes one.
 *
 * Neon sets `neon.max_cluster_size` on the compute from the project's plan.
 * It is not advisory: past it Neon makes the database READ-ONLY, which stops
 * bookings, tickets, parcels and payments for every existing user at once —
 * precisely the outcome this whole module exists to avoid.
 *
 * Read with the missing_ok form so a plain PostgreSQL (local development, CI,
 * a future move off Neon) simply reports nothing instead of erroring. A gate
 * that throws is a gate that blocks every registration, so the failure mode
 * here has to be "no opinion".
 *
 * @param {{query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>}} tx
 * @returns {Promise<number|null>} bytes, or null when the provider is silent
 */
export async function providerStorageLimit(tx) {
  try {
    const row = (await tx.query("SELECT current_setting('neon.max_cluster_size', true) AS value")).rows[0];
    const megabytes = Number(String(row?.value ?? '').trim());
    // Neon reports this in MB. Zero means "unlimited" on paid plans, which is
    // an absence of a limit rather than a limit of nothing.
    return Number.isFinite(megabytes) && megabytes > 0 ? Math.round(megabytes * 1024 * 1024) : null;
  } catch { return null; }
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
  const providerLimitBytes = await providerStorageLimit(tx);

  // The limit actually enforced is the SMALLER of what somebody configured and
  // what the database will really tolerate.
  //
  // Setting DATABASE_STORAGE_LIMIT_MB=10000 against a 512 MB plan would
  // otherwise leave the gate permanently unreachable: usage never approaches
  // the configured threshold, the console shows a comfortable percentage, and
  // the first anybody hears of it is the database refusing writes. A
  // configured value can tighten the door; it cannot prop it open.
  const candidates = [policy.limitBytes, providerLimitBytes].filter(value => typeof value === 'number');
  const limitBytes = candidates.length ? Math.min(...candidates) : null;
  const limitSource = limitBytes === null ? 'none'
    : policy.limitBytes !== null && limitBytes === policy.limitBytes ? 'configured' : 'provider';
  // Somebody configured a limit the database will not honour. The gate is
  // armed — on the real limit — but the configuration is still wrong, and
  // saying only "armed" would hide a number an operator is trusting.
  const overstated = policy.limitBytes !== null && providerLimitBytes !== null && policy.limitBytes > providerLimitBytes;

  const usedPercent = limitBytes ? Math.round((usedBytes / limitBytes) * 1000) / 10 : null;
  const open = policy.registrationEnabled && (usedPercent === null || usedPercent < policy.threshold);
  return {
    usedBytes,
    limitBytes,
    // What each side said, so a console can explain a disagreement rather than
    // just reporting the winner.
    configuredLimitBytes: policy.limitBytes,
    providerLimitBytes,
    limitSource,
    usedPercent,
    registrationStopPercent: policy.threshold,
    registrationEnabled: policy.registrationEnabled,
    registrationsOpen: open,
    // Whether the storage gate can actually fire.
    //
    // Without any limit at all there is nothing to measure against, so
    // `registrationsOpen` is true for the same reason an unplugged smoke alarm
    // is silent. Platform Ops was shown that as a green "capacity available",
    // which is the worst way to report a protection that is not running: the
    // one screen meant to warn about it confirmed the opposite. Said out loud
    // here so no console has to infer it from a null.
    storageProtection: limitBytes === null ? 'not_configured' : overstated ? 'misconfigured' : 'armed',
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
