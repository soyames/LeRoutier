/**
 * How much of the object-storage allowance is spent.
 *
 * The database half of this has existed for a while (registration.js measures
 * `pg_database_size` and refuses new accounts before the allowance runs out).
 * Objects had nothing at all: five gigabytes of files, no measurement anywhere,
 * and the first anybody would hear of it is a provider refusing a write.
 *
 * TWO NUMBERS, DELIBERATELY DIFFERENT.
 *
 *   accounted  — the sum of the sizes LeRoutier recorded for the objects it
 *                believes it holds. One cheap query, always available, and the
 *                figure the product can defend about its own data.
 *   measured   — what the bucket actually contains, read from the endpoint.
 *                Authoritative, costs a listing, and is the only thing that can
 *                see an object no row mentions.
 *
 * Reporting only the first would hide orphaned bytes; only the second would
 * hide rows whose object is gone. Where they disagree, the disagreement IS the
 * finding — which is why both are returned and neither is quietly preferred.
 */
import { invariant } from '@leroutier/domain';

/** The Neon Free plan's object allowance. A ceiling, not a target. */
export const FREE_OBJECT_BYTES = 5 * 1024 ** 3;

/**
 * Environment-driven policy, read per call so a redeploy-free change takes
 * effect on the next invocation — the same rule registration.js follows.
 */
export function objectStoragePolicy(env = process.env) {
  const limitMb = Number(env.OBJECT_STORAGE_LIMIT_MB);
  const warnPercent = Number(env.OBJECT_STORAGE_WARN_PERCENT);
  return {
    // Defaults to the Free allowance rather than to "no limit": a measurement
    // with nothing to measure against is a number nobody acts on, which is how
    // a limit becomes a surprise.
    limitBytes: Number.isFinite(limitMb) && limitMb > 0 ? Math.round(limitMb * 1024 * 1024) : FREE_OBJECT_BYTES,
    limitSource: Number.isFinite(limitMb) && limitMb > 0 ? 'configured' : 'free_plan_default',
    // 80%, inside a sane band: below 50 would alarm constantly, at 100 would
    // say nothing until it was already too late.
    warnPercent: Number.isFinite(warnPercent) && warnPercent >= 50 && warnPercent <= 99 ? warnPercent : 80,
  };
}

/** `ok` | `watch` | `high` | `over` — one word a console can colour and a
 * threshold a human can act on, rather than a bare percentage. */
const pressureOf = (usedPercent, warnPercent) => {
  if (usedPercent === null) return 'unknown';
  if (usedPercent >= 100) return 'over';
  if (usedPercent >= 95) return 'high';
  if (usedPercent >= warnPercent) return 'watch';
  return 'ok';
};

/**
 * What LeRoutier accounts for.
 *
 * Both stores of record are summed, because both hold objects: the media
 * registry and KYC evidence. Redacted evidence and deleted media are excluded —
 * those rows are pointers that have deliberately been cleared.
 *
 * Takes a transaction rather than a database, exactly as `registrationCapacity`
 * does, so Platform Ops can report it inside the health projection it is
 * already running instead of opening a second connection beside it.
 *
 * @param {{query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>}} tx
 */
export async function accountedObjectBytes(tx) {
  const row = (await tx.query(`
    SELECT
      (SELECT count(*) FROM media WHERE status <> 'deleted')::integer AS media_objects,
      (SELECT coalesce(sum(byte_size),0) FROM media WHERE status <> 'deleted')::bigint AS media_bytes,
      (SELECT count(*) FROM verification_evidence WHERE redacted_at IS NULL AND byte_size IS NOT NULL)::integer AS evidence_objects,
      (SELECT coalesce(sum(byte_size),0) FROM verification_evidence WHERE redacted_at IS NULL AND byte_size IS NOT NULL)::bigint AS evidence_bytes
  `)).rows[0];
  const mediaObjects = Number(row?.media_objects ?? 0), mediaBytes = Number(row?.media_bytes ?? 0);
  const evidenceObjects = Number(row?.evidence_objects ?? 0), evidenceBytes = Number(row?.evidence_bytes ?? 0);
  return {
    objects: mediaObjects + evidenceObjects,
    bytes: mediaBytes + evidenceBytes,
    media: { objects: mediaObjects, bytes: mediaBytes },
    evidence: { objects: evidenceObjects, bytes: evidenceBytes },
  };
}

/**
 * What the buckets actually hold, read from the endpoint.
 *
 * Never called from a health poll: it is a listing per bucket, and six console
 * screens poll health. This is the reconciliation figure, for a human or a
 * scheduled job.
 *
 * @param {Array<{name: string, store: {list: Function}|null}>} buckets
 */
export async function measuredObjectBytes(buckets = []) {
  const perBucket = [];
  let bytes = 0, objects = 0, truncated = false, reachable = true;
  for (const bucket of buckets) {
    if (!bucket?.store) { perBucket.push({ bucket: bucket?.name ?? 'unknown', reachable: false, objects: 0, bytes: 0 }); reachable = false; continue; }
    try {
      const listing = await bucket.store.list({});
      const bucketBytes = listing.objects.reduce((sum, object) => sum + Number(object.size ?? 0), 0);
      objects += listing.objects.length; bytes += bucketBytes; truncated ||= listing.truncated;
      perBucket.push({ bucket: bucket.name, reachable: true, objects: listing.objects.length, bytes: bucketBytes, truncated: listing.truncated });
    } catch {
      // A bucket that cannot be listed is reported as unreachable rather than
      // as empty. "Zero bytes" and "we could not ask" are different facts, and
      // only one of them is reassuring.
      reachable = false;
      perBucket.push({ bucket: bucket.name, reachable: false, objects: null, bytes: null });
    }
  }
  return { reachable, objects, bytes, truncated, buckets: perBucket };
}

/**
 * The figure a console shows and a threshold is checked against.
 *
 * Cheap by construction — the measured half is passed in only when somebody has
 * already paid for it.
 */
export async function objectStorageUsage(tx, { policy = objectStoragePolicy(), measured = null } = {}) {
  const accounted = await accountedObjectBytes(tx);
  const usedBytes = accounted.bytes;
  const usedPercent = policy.limitBytes ? Math.round((usedBytes / policy.limitBytes) * 1000) / 10 : null;
  return {
    accounted,
    measured,
    limitBytes: policy.limitBytes,
    limitSource: policy.limitSource,
    usedPercent,
    warnPercent: policy.warnPercent,
    pressure: pressureOf(usedPercent, policy.warnPercent),
    // Whether the measurement the threshold relies on needed a provider call.
    // Said out loud so nobody mistakes an accounted figure for a measured one.
    basis: measured ? 'provider_listing' : 'registry_accounting',
  };
}

/** A printable line, used by the script and by nothing that serves a request. */
export const formatBytes = bytes => {
  invariant(Number.isFinite(bytes), 'INVALID_INPUT', 'A byte count is required.');
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(1)} ${units[unit]}`;
};
