// How close the pilot is to its allowances, database and objects.
//
//   pnpm storage:usage            against whatever DATABASE_URL selects
//   pnpm storage:usage --measured also lists the buckets (costs a listing)
//
// Read-only. It writes nothing, creates nothing and deletes nothing; the whole
// point is to see a number before it becomes a surprise.
//
// TWO OBJECT FIGURES, because they answer different questions. `accounted` is
// what LeRoutier believes it holds — one query, always available. `measured` is
// what the buckets actually contain — authoritative, and the only thing that
// can see bytes no row mentions. Where they disagree, the disagreement is the
// finding.
import { createDatabase } from '../src/index.js';
import { serverConfig } from '@leroutier/config';
import { registrationCapacity } from '../src/registration.js';
import { objectStorageUsage, measuredObjectBytes, objectStoragePolicy, formatBytes } from '../src/object-usage.js';
import { s3Store } from '../src/s3-storage.js';

const wanted = process.argv.includes('--measured');
const config = serverConfig();
const db = createDatabase(config);

const percent = value => value === null || value === undefined ? 'n/a' : `${value}%`;
const word = pressure => ({ ok: 'OK', watch: 'WATCH', high: 'HIGH', over: 'OVER', unknown: 'UNKNOWN' })[pressure] ?? pressure;

try {
  // ------------------------------------------------------------- database --
  const capacity = await db.transaction(tx => registrationCapacity(tx));

  // --------------------------------------------------------------- objects --
  const s3 = config.objectStorage?.s3 ?? {};
  // One read-only store per bucket. Built here rather than taken from the
  // purpose-built stores because those wrap the listing away — a media store
  // that could enumerate its bucket is a wider surface than a media store
  // needs, and this script is the only thing that wants the wider one.
  const buckets = [
    config.evidenceStorage?.bucket && { name: config.evidenceStorage.bucket, store: s3Store({ ...s3, bucket: config.evidenceStorage.bucket }) },
    config.mediaStorage?.bucket && { name: config.mediaStorage.bucket, store: s3Store({ ...s3, bucket: config.mediaStorage.bucket }) },
  ].filter(Boolean);

  const policy = objectStoragePolicy();
  const measured = wanted && buckets.length ? await measuredObjectBytes(buckets) : null;
  const objects = await db.transaction(tx => objectStorageUsage(tx, { policy, measured }));

  console.log('Storage usage (read-only)\n');
  console.log('  DATABASE');
  console.log(`    used              ${formatBytes(capacity.usedBytes)} of ${capacity.limitBytes ? formatBytes(capacity.limitBytes) : 'no limit'}`);
  console.log(`    percent           ${percent(capacity.usedPercent)}   (registration stops at ${capacity.registrationStopPercent}%)`);
  console.log(`    protection        ${capacity.storageProtection}   (limit from: ${capacity.limitSource})`);
  console.log(`    registrations     ${capacity.registrationsOpen ? 'open' : `closed (${capacity.reason})`}`);
  console.log('\n  OBJECTS');
  console.log(`    accounted         ${formatBytes(objects.accounted.bytes)} in ${objects.accounted.objects} object(s)`);
  console.log(`      evidence        ${formatBytes(objects.accounted.evidence.bytes)} in ${objects.accounted.evidence.objects} object(s)`);
  console.log(`      media           ${formatBytes(objects.accounted.media.bytes)} in ${objects.accounted.media.objects} object(s)`);
  console.log(`    allowance         ${formatBytes(objects.limitBytes)}   (${objects.limitSource}, warn at ${objects.warnPercent}%)`);
  console.log(`    percent           ${percent(objects.usedPercent)}   ${word(objects.pressure)}`);

  if (measured) {
    console.log(`    measured          ${measured.reachable ? `${formatBytes(measured.bytes)} in ${measured.objects} object(s)` : 'UNREACHABLE — no bucket could be listed'}`);
    for (const bucket of measured.buckets) {
      console.log(`      ${bucket.bucket.padEnd(28)} ${bucket.reachable ? `${formatBytes(bucket.bytes)} in ${bucket.objects}${bucket.truncated ? ' (truncated)' : ''}` : 'unreachable'}`);
    }
    const drift = measured.reachable ? measured.bytes - objects.accounted.bytes : null;
    if (drift !== null && drift !== 0) {
      console.log(`    DRIFT             ${drift > 0 ? '+' : ''}${formatBytes(Math.abs(drift))} ${drift > 0 ? 'the bucket holds more than any row accounts for' : 'rows account for more than the bucket holds'}`);
      console.log('                      run the reconciliation before trusting either figure');
    }
  } else if (buckets.length) {
    console.log('    measured          not taken — pass --measured to list the buckets');
  } else {
    console.log('    measured          no object store is configured');
  }

  console.log('\n  Nearest threshold:', capacity.usedPercent !== null && objects.usedPercent !== null
    ? (objects.usedPercent >= capacity.usedPercent ? `objects at ${percent(objects.usedPercent)}` : `database at ${percent(capacity.usedPercent)}`)
    : 'unknown');
} catch (error) {
  console.error('Storage usage failed:', error.code ?? error.message);
  process.exitCode = 1;
} finally { await db.close(); }
