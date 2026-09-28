// One measurement, for every day of the pilot.
//
//   pnpm pilot:measure                     print today's line
//   pnpm pilot:measure --measured          also list the buckets (costs a listing)
//   pnpm pilot:measure --append pilot.jsonl   append it, so a series accumulates
//
// Read-only: it writes nothing to the database and nothing to storage. The only
// file it touches is the one you name with --append.
//
// WHY A SCRIPT AND NOT A DASHBOARD. A pilot's infrastructure forecast is built
// from a handful of numbers taken on the days things actually happened, and the
// measurements that matter are the ones somebody will still be able to compare
// in three weeks. A JSON line per day does that; a screen does not.
//
// WHAT IT CANNOT MEASURE. Compute hours. Neon does not publish them to SQL —
// 127 `neon.*` settings exist and none of them is usage — so they are read from
// the Neon console by a person and recorded in the field journal beside these
// numbers. Recording the field as null rather than omitting it is deliberate:
// a series that quietly lacks a column reads as though the column was never
// needed.
import fs from 'node:fs';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '../src/index.js';
import { registrationCapacity } from '../src/registration.js';
import { formatBytes, measuredObjectBytes, objectStoragePolicy, objectStorageUsage } from '../src/object-usage.js';
import { s3Store } from '../src/s3-storage.js';

const args = new Set(process.argv.slice(2));
const valueOf = name => { const at = process.argv.indexOf(name); return at === -1 ? null : process.argv[at + 1]; };
const withMeasured = args.has('--measured');
const appendTo = valueOf('--append');

const config = serverConfig();
const db = createDatabase(config);

const scalar = async sql => Number(((await db.transaction(async tx => (await tx.query(sql)).rows))[0] ?? {}).n ?? 0);

try {
  // ------------------------------------------------------------- the wire --
  const s3 = config.objectStorage?.s3 ?? {};
  const buckets = [
    config.evidenceStorage?.bucket && { name: config.evidenceStorage.bucket, store: s3Store({ ...s3, bucket: config.evidenceStorage.bucket }) },
    config.mediaStorage?.bucket && { name: config.mediaStorage.bucket, store: s3Store({ ...s3, bucket: config.mediaStorage.bucket }) },
  ].filter(Boolean);

  const policy = objectStoragePolicy();
  const measured = withMeasured && buckets.length ? await measuredObjectBytes(buckets) : null;
  const usage = await db.transaction(tx => objectStorageUsage(tx, { policy, measured }));
  const capacity = await db.transaction(tx => registrationCapacity(tx));

  // --------------------------------------------------------- the activity --
  // Everything measured over the same window — the last 24 hours — so the
  // numbers can be summed across days without anybody remembering which one
  // was cumulative.
  const day = {
    gpsWrites: await scalar("SELECT count(*)::int AS n FROM vehicle_positions WHERE received_at > now()-interval '24 hours'"),
    apiRequests: await scalar("SELECT coalesce(sum(requests),0)::int AS n FROM request_limits WHERE window_at > now()-interval '24 hours'"),
    outboxEvents: await scalar("SELECT count(*)::int AS n FROM outbox WHERE created_at > now()-interval '24 hours'"),
    auditEvents: await scalar("SELECT count(*)::int AS n FROM audit_events WHERE created_at > now()-interval '24 hours'"),
    apiErrors: await scalar("SELECT coalesce(sum(count),0)::int AS n FROM operational_signals WHERE signal='api_error' AND minute > now()-interval '24 hours'"),
    gpsAnomalies: await scalar("SELECT coalesce(sum(count),0)::int AS n FROM operational_signals WHERE signal='gps_anomaly' AND minute > now()-interval '24 hours'"),
    webhookRejected: await scalar("SELECT coalesce(sum(count),0)::int AS n FROM operational_signals WHERE signal='webhook_rejected' AND minute > now()-interval '24 hours'"),
  };

  const record = {
    measuredAt: new Date().toISOString(),
    database: { bytes: capacity.usedBytes, percentOfAllowance: capacity.usedPercent,
      allowanceBytes: capacity.limitBytes, protection: capacity.storageProtection, registrationsOpen: capacity.registrationsOpen },
    objects: { accountedBytes: usage.accounted.bytes, accountedObjects: usage.accounted.objects,
      evidenceBytes: usage.accounted.evidence.bytes, mediaBytes: usage.accounted.media.bytes,
      measuredBytes: measured?.reachable ? measured.bytes : null,
      // Positive means the bucket holds more than any row accounts for — bytes
      // being paid for that LeRoutier cannot name.
      driftBytes: measured?.reachable ? measured.bytes - usage.accounted.bytes : null,
      allowanceBytes: usage.limitBytes, percentOfAllowance: usage.usedPercent, pressure: usage.pressure },
    activity: day,
    // Read from the Neon console by a person. Null here is a value, not a gap.
    compute: { cuHours: null, source: 'neon_console' },
  };

  // ---------------------------------------------------------------- print --
  /** Which of four things is true about the listing, said precisely. */
  const measuredLine = () => {
    if (!withMeasured) return 'not taken (pass --measured to list the buckets)';
    if (!buckets.length) {
      return 'no object store configured here — MEDIA_STORAGE_* / EVIDENCE_STORAGE_* / S3_* are set on the deployment, not in .env.local';
    }
    if (!measured?.reachable) return 'UNREACHABLE — a bucket exists but could not be listed';
    return `${formatBytes(measured.bytes)} in ${measured.objects}${measured.truncated ? ' (truncated — the figure is a floor, not a total)' : ''}`;
  };

  console.log(`Pilot measurement — ${record.measuredAt}\n`);
  console.log('  DATABASE');
  // `limitBytes` is null whenever nothing states an allowance, and that is the
  // normal state on a developer machine: DATABASE_STORAGE_LIMIT_MB lives on the
  // deployment, and Neon does not publish its own limit over the pooled
  // connection. Printing "null" here would be a small lie; formatBytes requiring
  // a real number would be a crash. Say which of the two facts is true.
  console.log(record.database.allowanceBytes === null
    ? `    ${formatBytes(record.database.bytes)}, no allowance configured here (${record.database.protection})`
    : `    ${formatBytes(record.database.bytes)} of ${formatBytes(record.database.allowanceBytes)} (${record.database.percentOfAllowance}%), ${record.database.protection}`);
  console.log('  OBJECTS');
  console.log(`    accounted   ${formatBytes(record.objects.accountedBytes)} in ${record.objects.accountedObjects}`);
  // Four distinct states, and saying the wrong one is worse than saying
  // nothing: "not taken" when somebody DID ask is the message that made this
  // script look broken while it was behaving correctly.
  console.log(`    measured    ${measuredLine()}`);
  console.log(`    drift       ${record.objects.driftBytes === null ? 'unknown — needs a listing to compare against' : formatBytes(record.objects.driftBytes)}`);
  console.log(record.objects.allowanceBytes === null
    ? '    allowance   none configured'
    : `    allowance   ${formatBytes(record.objects.allowanceBytes)} (${record.objects.percentOfAllowance ?? 'n/a'}%, ${record.objects.pressure})`);
  console.log('  ACTIVITY (last 24h)');
  console.log(`    gps writes ${day.gpsWrites}   api requests ${day.apiRequests}   outbox ${day.outboxEvents}   audit ${day.auditEvents}`);
  console.log(`    errors     api ${day.apiErrors}   gps anomalies ${day.gpsAnomalies}   webhooks rejected ${day.webhookRejected}`);
  console.log('  COMPUTE');
  console.log('    cu-hours    read from the Neon console; recorded in the field journal');

  if (appendTo) {
    fs.appendFileSync(appendTo, JSON.stringify(record) + '\n');
    console.log(`\n  appended to ${appendTo}`);
  }
} catch (error) {
  console.error('Pilot measurement failed:', error.code ?? error.message);
  process.exitCode = 1;
} finally { await db.close(); }
