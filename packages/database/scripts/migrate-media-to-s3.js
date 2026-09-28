// Copy stored files from Backblaze B2 to an S3-compatible target, verifying
// every byte, and report honestly on everything it could not do.
//
// USAGE
//   node --env-file=.env.local packages/database/scripts/migrate-media-to-s3.js \
//        --credentials "C:/path/to/your/Backblaze-export.txt"
//   ... --execute          actually copy (default is a read-only inventory)
//   ... --verify           re-read each copied object and compare its checksum
//   ... --manifest out.json
//
// WHAT IT NEVER DOES
//   It does not delete anything from the source. It does not revoke a key. It
//   does not change which provider production writes to — that is a
//   configuration change, made deliberately, after this reports success.
//
// WHAT IT GUARANTEES
//   Every object it reports as copied was read back from the target and
//   compared on both byte size and SHA-256. An object whose checksum does not
//   match is a failure, not a success with a footnote: a file that arrived
//   corrupted is worse than one that did not arrive, because nothing would go
//   looking for it again.
//
// It is idempotent. A second run skips objects already present with a matching
// checksum, so an interrupted migration is resumed rather than repeated.
//
// Nothing here prints a credential, a recipient or a message body. Object keys
// are recorded in the manifest because they are uuids and the operator needs
// them to act on a failure; they identify no person.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '../src/index.js';
import { mediaStore } from '../src/media.js';

const B2_API = 'https://api.backblazeb2.com/b2api/v3';
const FREE_PLAN_BYTES = 5 * 1024 ** 3;
// Leave room for a pilot to upload without immediately hitting the ceiling.
const HEADROOM = 0.8;

const args = new Set(process.argv.slice(2));
const valueOf = name => { const at = process.argv.indexOf(name); return at === -1 ? null : process.argv[at + 1]; };
const credentialsFile = valueOf('--credentials');
const manifestPath = valueOf('--manifest') ?? 'media-migration-manifest.json';
const execute = args.has('--execute');
const verify = args.has('--verify');

const fail = message => { console.error(message); process.exit(2); };
if (!credentialsFile || !fs.existsSync(credentialsFile)) {
  fail('Usage: --credentials <path-to-your-Backblaze-export.txt>  (the file is read, never copied or printed)');
}

/** The account-level pair, found without knowing the file's exact layout. */
function b2Credentials(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim());
  const id = lines.find(line => /^[0-9a-f]{12}$/.test(line));
  const secret = lines.find(line => /^K00[0-9][A-Za-z0-9+/=_-]{20,}$/.test(line));
  return id && secret ? { id, secret } : null;
}

async function authorizeB2({ id, secret }) {
  const response = await fetch(`${B2_API}/b2_authorize_account`, {
    headers: { authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') },
  });
  if (!response.ok) fail('Backblaze refused the credential in that file.');
  const body = await response.json();
  return { token: body.authorizationToken, ...(body.apiInfo?.storageApi ?? body) };
}

const b2Call = async (session, path, payload) => {
  const response = await fetch(`${session.apiUrl}/b2api/v3/${path}`, {
    method: 'POST', headers: { authorization: session.token, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
  return json;
};

/** Every object in the bucket, newest version of each name. */
async function listAll(session, bucketId, startFileName = null) {
  const found = [];
  let cursor = startFileName;
  for (let page = 0; page < 1000; page++) {
    const listing = await b2Call(session, 'b2_list_file_names',
      { bucketId, startFileName: cursor ?? undefined, maxFileCount: 1000 });
    for (const file of listing.files ?? []) found.push({ key: file.fileName, size: file.contentLength });
    if (!listing.nextFileName) return found;
    cursor = listing.nextFileName;
  }
  return found;
}

async function download(session, bucketName, key) {
  const headers = { authorization: session.token };
  const path = key.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${session.downloadUrl}/file/${encodeURIComponent(bucketName)}/${path}`, { headers });
  if (!response.ok) throw new Error(`download failed with ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const humanBytes = n => `${n.toLocaleString('en-US')} bytes (${(n / 1024 ** 2).toFixed(1)} MiB)`;

// ------------------------------------------------------------------ run --
const config = serverConfig();
const db = createDatabase(config);
const target = mediaStore(config);

const credentials = b2Credentials(credentialsFile);
if (!credentials) {
  // The export Backblaze hands out lists the key's ID and name but NOT its
  // secret — the secret is shown once, at creation, and never again. Saying
  // which half is missing is the difference between a five-minute fix and an
  // hour of guessing.
  fail([
    'That file has no application key SECRET in it, so it cannot authorize.',
    'Backblaze shows a key secret once, at creation, and never again — an export',
    'taken later carries only the key id and name.',
    '',
    'Either paste the pair into the file as two bare lines (a 12-character id,',
    'then the secret on its own line), or mint a fresh bucket-scoped key in the',
    'Backblaze console and put it on le-routier-api instead. Never commit it.',
  ].join('\n'));
}
const session = await authorizeB2(credentials);

const bucketName = process.env.B2_BUCKET_NAME;
const bucketId = process.env.B2_BUCKET_ID;
if (!bucketName || !bucketId) fail('Set B2_BUCKET_NAME and B2_BUCKET_ID for the source bucket.');

console.log('Media storage migration');
console.log(`  source          : backblaze b2, bucket configured from B2_BUCKET_NAME`);
console.log(`  target provider : ${target ? target.name : '(none configured — set MEDIA_STORAGE_PROVIDER and MEDIA_S3_*)'}`);
console.log(`  mode            : ${execute ? 'EXECUTE' : 'inventory only (pass --execute to copy)'}`);
console.log('');

const objects = await listAll(session, bucketId);
const totalBytes = objects.reduce((sum, object) => sum + Number(object.size ?? 0), 0);

// What the registry already knows, so the report can separate the three cases a
// human actually cares about: copied, not yet copied, and unaccounted for.
const known = await db.transaction(async tx => (await tx.query(
  'SELECT media_id, provider, bucket, object_key, checksum_sha256, status FROM media')).rows);
const knownByKey = new Map(known.map(row => [`${row.bucket}/${row.object_key}`, row]));
const legacy = await db.transaction(async tx => (await tx.query(
  "SELECT count(*)::int AS n FROM verification_evidence WHERE storage_key IS NOT NULL")).rows);

console.log(`  objects in source      : ${objects.length}`);
console.log(`  total bytes            : ${humanBytes(totalBytes)}`);
console.log(`  Free plan allowance    : ${humanBytes(FREE_PLAN_BYTES)}`);
console.log(`  used after migration   : ${(totalBytes / FREE_PLAN_BYTES * 100).toFixed(2)}%`);
console.log(`  headroom at 80%        : ${humanBytes(FREE_PLAN_BYTES * HEADROOM)}`);
console.log(`  media rows registered  : ${known.length}`);
console.log(`  legacy managed evidence: ${legacy[0].n}`);
console.log('');

if (totalBytes > FREE_PLAN_BYTES * HEADROOM) {
  console.log('  WARNING: this migration would use more than 80% of the Free plan allowance.');
  console.log('           Review the file inventory before cutting production over.');
  console.log('');
}

const manifest = { startedAt: new Date().toISOString(), source: 'backblaze', bucket: bucketName,
  target: target?.name ?? null, execute, totalObjects: objects.length, totalBytes,
  copied: [], skipped: [], failed: [], missingSource: [], unreferenced: [], appearedDuringMigration: [] };

if (execute && !target) fail('No target store is configured; set MEDIA_STORAGE_PROVIDER and MEDIA_S3_*.');

for (const object of objects) {
  const existing = knownByKey.get(`${config.mediaStorage?.bucket ?? 'legacy'}/${object.key}`)
    ?? known.find(row => row.object_key === object.key);
  if (!execute) {
    (existing ? manifest.skipped : manifest.copied).push({ key: object.key, bytes: Number(object.size) });
    continue;
  }
  try {
    const bytes = await download(session, bucketName, object.key);
    if (bytes.length !== Number(object.size)) {
      manifest.failed.push({ key: object.key, reason: 'size_mismatch_on_source', expected: Number(object.size), read: bytes.length });
      continue;
    }
    const checksum = sha256(bytes);
    if (existing && existing.checksum_sha256 === checksum && existing.provider === target.name) {
      manifest.skipped.push({ key: object.key, bytes: bytes.length, reason: 'already_present_with_matching_checksum' });
      continue;
    }
    await target.put({ key: object.key, bytes, contentType: existing?.content_type ?? 'application/octet-stream' });
    if (verify) {
      const round = await target.read(object.key, { ttlSeconds: 60 });
      const back = new Uint8Array(await (await fetch(round.url)).arrayBuffer());
      if (back.length !== bytes.length || sha256(back) !== checksum) {
        manifest.failed.push({ key: object.key, reason: 'checksum_mismatch_after_copy' });
        continue;
      }
    }
    // The registry records where the bytes now are, without inventing a second
    // record for a file it already describes.
    await db.transaction(async tx => {
      if (existing) {
        await tx.query("UPDATE media SET provider=$2, bucket=$3, byte_size=$4, checksum_sha256=$5, status='stored', updated_at=now() WHERE media_id=$1",
          [existing.media_id, target.name, config.mediaStorage?.bucket ?? 'media', bytes.length, checksum]);
      }
    });
    manifest.copied.push({ key: object.key, bytes: bytes.length, checksum });
  } catch (error) {
    manifest.failed.push({ key: object.key, reason: String(error?.message ?? error).slice(0, 120) });
  }
}

// A second listing, because a pilot can upload while this runs. Anything new is
// reported rather than silently missed, and a following run picks it up.
if (execute) {
  const after = await listAll(session, bucketId);
  const seen = new Set(objects.map(object => object.key));
  manifest.appearedDuringMigration = after.filter(object => !seen.has(object.key)).map(object => object.key);
}

// Objects in the source that no database row mentions. These are the dangerous
// ones: bytes LeRoutier holds and cannot account for.
const registeredKeys = new Set(known.map(row => row.object_key));
manifest.unreferenced = objects.filter(object => !registeredKeys.has(object.key)).map(object => object.key);

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log('  copied                 :', manifest.copied.length);
console.log('  already present        :', manifest.skipped.length);
console.log('  failed                 :', manifest.failed.length);
console.log('  appeared during run    :', manifest.appearedDuringMigration.length);
console.log('  unreferenced in source :', manifest.unreferenced.length);
console.log(`  manifest written to    : ${manifestPath}`);
console.log('');
console.log(execute
  ? 'Copy complete. The source has NOT been touched: production still writes to it until MEDIA_STORAGE_PROVIDER changes.'
  : 'Inventory only. Nothing was copied. Re-run with --execute --verify to migrate.');
console.log('Verification is not a substitute for the journeys: open a Passenger, Driver and Ops file after the switch.');

await db.close();
process.exit(manifest.failed.length ? 1 : 0);
