// How much of the object allowance is spent, and — the part that matters —
// which of the two numbers is being reported and whether they disagree.
//
// The database half of this has been gated for a while. Objects had nothing, so
// five gigabytes could fill with no number anywhere saying so; these tests pin
// the measurement that closes that, and in particular pin that a bucket which
// CANNOT be listed is never reported as an empty one.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { FREE_OBJECT_BYTES, accountedObjectBytes, formatBytes, measuredObjectBytes, objectStoragePolicy, objectStorageUsage } from '../src/object-usage.js';
import { newMediaId } from '../src/media.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows))[0];

/** A store that answers with a fixed listing, or refuses. */
const fakeStore = ({ objects = [], fail = false, truncated = false } = {}) => ({
  async list() { if (fail) throw new Error('unreachable'); return { objects, truncated }; },
});

before(async () => { await migrate(db); await seed(db); });
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('the allowance defaults to the Free plan rather than to no limit', () => {
  // A measurement with nothing to measure against is a number nobody acts on,
  // which is exactly how a limit becomes a surprise.
  assert.equal(objectStoragePolicy({}).limitBytes, FREE_OBJECT_BYTES);
  assert.equal(objectStoragePolicy({}).limitSource, 'free_plan_default');
  assert.equal(objectStoragePolicy({ OBJECT_STORAGE_LIMIT_MB: '1024' }).limitBytes, 1024 * 1024 * 1024);
  assert.equal(objectStoragePolicy({ OBJECT_STORAGE_LIMIT_MB: '1024' }).limitSource, 'configured');
  assert.equal(objectStoragePolicy({ OBJECT_STORAGE_LIMIT_MB: '0' }).limitBytes, FREE_OBJECT_BYTES,
    'a zero limit is not a limit of nothing');
  // Outside the sane band the value is ignored rather than trusted, so a typo
  // cannot make the warning scream from the first byte or stay silent forever.
  assert.equal(objectStoragePolicy({ OBJECT_STORAGE_WARN_PERCENT: '5' }).warnPercent, 80);
  assert.equal(objectStoragePolicy({ OBJECT_STORAGE_WARN_PERCENT: '150' }).warnPercent, 80);
  assert.equal(objectStoragePolicy({ OBJECT_STORAGE_WARN_PERCENT: '70' }).warnPercent, 70);
});

test('accounted bytes count both stores of record, and neither a cleared pointer', async () => {
  const owner = (await one(`INSERT INTO users(auth_subject,auth_issuer,display_name,role)
    VALUES($1,'https://issuer.test.invalid','Test','passenger') RETURNING id`, ['usage-' + randomUUID()])).id;
  const operator = (await one(`INSERT INTO operators(name,type,verification_status) VALUES('TEST','company','verified') RETURNING id`)).id;

  // The real generator, not a hand-rolled id: the schema constrains media ids
  // to the base32 alphabet, and a uuid's hex digits 0/1/8/9 are not in it.
  const insertMedia = (bytes, status) => db.transaction(async tx => tx.query(
    `INSERT INTO media(media_id,owner_user_id,subject_user_id,purpose,provider,bucket,object_key,content_type,byte_size,checksum_sha256,status)
     VALUES($1,$2,$2,'incident_evidence','neon','b','k/'||$1,'application/pdf',$3,$4,$5)`,
    [newMediaId(), owner, bytes, 'a'.repeat(64), status]));

  await insertMedia(1000, 'stored');
  await insertMedia(2000, 'stored');
  await insertMedia(9999, 'deleted');
  await db.transaction(async tx => tx.query(`INSERT INTO verification_evidence(operator_id,kind,reference,status,content_type,byte_size,storage_key,storage_provider)
    VALUES($1,'identity','REF','pending','application/pdf',500,'evidence/x/y/z','neon')`, [operator]));
  // A redacted row is a pointer that was deliberately cleared: it holds nothing.
  await db.transaction(async tx => tx.query(`INSERT INTO verification_evidence(operator_id,kind,reference,status,content_type,byte_size,redacted_at)
    VALUES($1,'identity','GONE','rejected','application/pdf',777,now())`, [operator]));

  const accounted = await db.transaction(tx => accountedObjectBytes(tx));
  assert.equal(accounted.media.bytes, 3000, 'deleted media holds no bytes');
  assert.equal(accounted.media.objects, 2);
  assert.equal(accounted.evidence.bytes, 500, 'redacted evidence holds no bytes');
  assert.equal(accounted.bytes, 3500);
  assert.equal(accounted.objects, 3);
});

test('a bucket that cannot be listed is unreachable, never empty', async () => {
  // "Zero bytes" and "we could not ask" are different facts, and only one of
  // them is reassuring.
  const measured = await measuredObjectBytes([
    { name: 'good', store: fakeStore({ objects: [{ key: 'a', size: 10 }, { key: 'b', size: 32 }] }) },
    { name: 'bad', store: fakeStore({ fail: true }) },
    { name: 'missing', store: null },
  ]);
  assert.equal(measured.reachable, false);
  assert.equal(measured.bytes, 42, 'the reachable buckets still contribute');
  assert.deepEqual(measured.buckets.find(entry => entry.bucket === 'bad'), { bucket: 'bad', reachable: false, objects: null, bytes: null });
  assert.equal(measured.buckets.find(entry => entry.bucket === 'missing').reachable, false);
});

test('a truncated listing says so rather than reporting a comfortable number', async () => {
  const measured = await measuredObjectBytes([{ name: 'b', store: fakeStore({ objects: [{ key: 'a', size: 5 }], truncated: true }) }]);
  assert.equal(measured.truncated, true, 'a usage figure that silently caps is worse than none');
});

test('pressure is a word that can be acted on, and the basis is never implied', async () => {
  const usage = await db.transaction(tx => objectStorageUsage(tx, { policy: { limitBytes: 1000, limitSource: 'configured', warnPercent: 80 } }));
  assert.equal(usage.basis, 'registry_accounting', 'without a listing, the figure is the registry’s own');
  assert.equal(usage.limitBytes, 1000);

  const listing = await measuredObjectBytes([{ name: 'b', store: fakeStore({ objects: [{ key: 'a', size: 1 }] }) }]);
  const withListing = await db.transaction(tx => objectStorageUsage(tx, {
    policy: { limitBytes: 1000, limitSource: 'configured', warnPercent: 80 }, measured: listing,
  }));
  assert.equal(withListing.basis, 'provider_listing');

  // The thresholds themselves, stated once so a console does not invent them.
  // Derived from what is actually stored rather than assuming a figure, so this
  // holds whatever ran before it.
  const stored = await db.transaction(tx => accountedObjectBytes(tx));
  const pressureAt = async limitBytes => (await db.transaction(tx =>
    objectStorageUsage(tx, { policy: { limitBytes, limitSource: 'configured', warnPercent: 80 } }))).pressure;
  assert.equal(await pressureAt(Math.max(1, Math.floor(stored.bytes / 2))), 'over', 'over the allowance');
  assert.equal(await pressureAt(stored.bytes * 100), 'ok', 'comfortably inside it');
});

test('byte sizes print the way an operator reads them', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GiB');
});
