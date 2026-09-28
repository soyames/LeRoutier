// The media registry, and the S3 backend underneath it.
//
// The signing is checked against AWS's OWN published test vectors rather than
// against our own output: a self-referential test would pass just as happily if
// the whole construction drifted, and every provider would then reject every
// request while the suite stayed green.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { MAX_MEDIA_BYTES, MEDIA_READ_TTL_SECONDS, mediaService, mediaStore, memoryMediaStore, newMediaId } from '../src/media.js';
import { presignUrl, s3Store, signRequest, uriEncode } from '../src/s3-storage.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);

const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows))[0];
const many = async (sql, args = []) => db.transaction(async tx => (await tx.query(sql, args)).rows);

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const AWS = {
  payloadHash: EMPTY_SHA256, region: 'us-east-1', service: 'service',
  accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  date: new Date('2015-08-30T12:36:00Z'),
};
const AWS_HEADERS = { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' };

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3]);

let operatorId;
before(async () => {
  await migrate(db); await seed(db);
  operatorId = (await one('SELECT id FROM operators LIMIT 1')).id;
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

async function newUser({ role = 'passenger', operator = null } = {}) {
  return (await one(`INSERT INTO users(auth_subject,auth_issuer,display_name,role,operator_id)
    VALUES($1,'https://issuer.test.invalid','Test','${role}',$2) RETURNING id`, ['media-' + randomUUID(), operator])).id;
}

// ----------------------------------------------------------- the signature --
test('the signing reproduces AWS’s own published vectors', () => {
  // From the AWS Signature Version 4 test suite.
  /** @type {[string, any, string][]} */
  const vectors = [
    ['get-vanilla', { method: 'GET', path: '/', query: {} },
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'],
    ['get-vanilla-query-order-key-case', { method: 'GET', path: '/', query: { Param2: 'value2', Param1: 'value1' } },
      'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500'],
  ];
  for (const [name, input, expected] of vectors) {
    const { signature } = signRequest({ ...AWS, ...input, headers: AWS_HEADERS });
    assert.equal(signature, expected, `AWS vector ${name}`);
  }
});

test('encoding is RFC 3986, not encodeURIComponent', () => {
  // encodeURIComponent leaves these five bare and AWS does not, so a key
  // containing any of them would be signed one way and sent another — a
  // mismatch that reads exactly like a broken credential.
  assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A');
  assert.equal(uriEncode('a b'), 'a%20b');
  assert.equal(uriEncode('~-_.'), '~-_.', 'the unreserved set is left alone');
  assert.equal(uriEncode('a/b', false), 'a/b', 'a path keeps its separators');
  assert.equal(uriEncode('a/b'), 'a%2Fb', 'a bare value does not');
});

test('a half-configured store is no store, never one that fails on first use', () => {
  assert.equal(s3Store({}), null);
  assert.equal(s3Store({ endpoint: 'https://s3.example.invalid', region: 'eu-central-1' }), null, 'no bucket, no credentials');
  assert.equal(s3Store({ endpoint: 'https://s3.example.invalid', region: 'eu-central-1', bucket: 'b', accessKeyId: 'k' }), null, 'no secret');
  assert.ok(s3Store({ endpoint: 'https://s3.example.invalid', region: 'eu-central-1', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }));
});

test('an unrecognised provider fails closed rather than falling back', () => {
  assert.equal(mediaStore({}), null, 'nothing configured is a supported state');
  assert.ok(mediaStore({ mediaStorage: { provider: 'neon', s3: { endpoint: 'https://e.invalid', region: 'r', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' } } }),
    'neon resolves to the same S3 code path');
  assert.throws(() => mediaStore({ mediaStorage: { provider: 'dropbox' } }), { code: 'EVIDENCE_STORAGE_UNAVAILABLE' });
});

test('the store signs its calls, and a read URL carries a signature and an expiry', async () => {
  const seen = [];
  const http = async (url, init = {}) => { seen.push({ url, method: init.method, headers: init.headers }); return new Response(null, { status: 200 }); };
  const store = s3Store({ endpoint: 'https://s3.example.invalid', region: 'eu-central-1', bucket: 'media',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }, http);

  const written = await store.put({ key: 'media/u/m1', bytes: PDF, contentType: 'application/pdf' });
  assert.equal(written.byteSize, PDF.length);
  assert.equal(written.checksumSha256, createHash('sha256').update(PDF).digest('hex'));
  assert.match(seen[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  assert.equal(seen[0].headers['x-amz-content-sha256'], written.checksumSha256);
  assert.ok(seen[0].url.endsWith('/media/media/u/m1'), 'path-style addressing, per Neon');

  const grant = await store.read('media/u/m1', { ttlSeconds: 90 });
  const url = new URL(grant.url);
  assert.ok(url.searchParams.get('X-Amz-Signature'), 'a URL without a signature would not open a private object');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '90');
  assert.ok(Date.parse(grant.expiresAt) > Date.now(), 'and it expires');

  // Deleting something already gone is the desired end state, so it is success.
  await store.remove('media/u/m1');
  const gone = s3Store({ endpoint: 'https://s3.example.invalid', region: 'eu-central-1', bucket: 'media',
    accessKeyId: 'k', secretAccessKey: 's' }, async () => new Response(null, { status: 404 }));
  await gone.remove('media/u/m1');
  // Anything else is a failure, because a caller that cannot tell "already
  // gone" from "the provider is down" will record a deletion that never happened.
  const broken = s3Store({ endpoint: 'https://s3.example.invalid', region: 'eu-central-1', bucket: 'media',
    accessKeyId: 'k', secretAccessKey: 's' }, async () => new Response(null, { status: 500 }));
  await assert.rejects(broken.remove('media/u/m1'), { code: 'EVIDENCE_STORAGE_UNAVAILABLE' });
});

test('a presigned URL expires, and its signature changes with the expiry', () => {
  const settings = { url: 'https://s3.example.invalid/media/media/u/m1', region: 'eu-central-1',
    service: 's3', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', date: AWS.date };
  const short = presignUrl({ ...settings, expiresSeconds: 60 });
  const long = presignUrl({ ...settings, expiresSeconds: 3600 });
  assert.notEqual(short, long);
  assert.ok(presignUrl({ ...settings, expiresSeconds: 10 ** 9 }).includes('X-Amz-Expires=604800'), 'clamped to the SigV4 maximum');
});

// -------------------------------------------------------------- the ids --
test('a media id is opaque, well-formed and never repeats', () => {
  const ids = new Set(Array.from({ length: 500 }, newMediaId));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^med_[A-Z2-7]{26}$/);
  // It must not be derived from anything: an id that encoded an owner or a
  // purpose would make one caller's URL a template for everybody else's.
  assert.ok(![...ids].some(id => /[0-9a-f]{8}-/.test(id)));
});

// ---------------------------------------------------------- the registry --
async function registry({ store = memoryMediaStore() } = {}) {
  return { store, media: mediaService(db, store, { bucket: 'media' }) };
}

test('an upload stores the bytes and registers them, with a checksum of what arrived', async () => {
  const { store, media } = await registry();
  const userId = await newUser();
  const actor = { id: userId, role: 'passenger' };
  const uploaded = await media.upload(actor, { purpose: 'parcel_delivery_evidence', bytes: PDF });

  assert.match(uploaded.id, /^med_[A-Z2-7]{26}$/);
  assert.equal(uploaded.contentType, 'application/pdf');
  const row = await one('SELECT * FROM media WHERE media_id=$1', [uploaded.id]);
  assert.equal(row.status, 'stored');
  assert.equal(row.visibility, 'private', 'private unless a human decided otherwise');
  assert.equal(Number(row.byte_size), PDF.length);
  assert.equal(row.checksum_sha256, createHash('sha256').update(PDF).digest('hex'));
  assert.equal(row.provider, 'memory');
  assert.equal(row.bucket, 'media');
  assert.ok(store.has(row.object_key), 'and the object is really there');
});

test('the file type is the bytes’ own, never the uploader’s claim', async () => {
  const { media } = await registry();
  const actor = { id: await newUser(), role: 'passenger' };
  // An SVG is an image everywhere else and a scripted page here. Declaring it a
  // PNG changes nothing, because the declaration is never consulted.
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await assert.rejects(media.upload(actor, { purpose: 'parcel_delivery_evidence', bytes: svg }), { code: 'INVALID_EVIDENCE_FILE' });
  // Nothing was registered for this uploader on the way to that refusal.
  assert.equal((await one('SELECT count(*)::int n FROM media WHERE owner_user_id=$1', [actor.id])).n, 0);
});

test('a file that is too large, empty, or for an unknown purpose is refused', async () => {
  const { media } = await registry();
  const actor = { id: await newUser(), role: 'passenger' };
  await assert.rejects(media.upload(actor, { purpose: 'parcel_delivery_evidence', bytes: new Uint8Array(0) }), { code: 'INVALID_MEDIA' });
  await assert.rejects(media.upload(actor, { purpose: 'parcel_delivery_evidence', bytes: new Uint8Array(MAX_MEDIA_BYTES + 1) }), { status: 413 });
  await assert.rejects(media.upload(actor, { purpose: 'whatever_i_like', bytes: PDF }), { code: 'INVALID_MEDIA' });
});

test('only the owner, a reviewer, or the operator reaches a file', async () => {
  const { store, media } = await registry();
  const owner = { id: await newUser(), role: 'passenger' };
  const stranger = { id: await newUser({ operator: operatorId }), role: 'passenger', operator_id: operatorId };
  const { id } = await media.upload(owner, { purpose: 'driver_kyc', bytes: PDF, associations: { operatorId } });

  const grant = await media.grant(owner, id);
  assert.ok(grant.url, 'the owner opens their own file');
  assert.ok(store.resolve(grant.url), 'and the URL really resolves');

  // A stranger gets the SAME answer as a made-up id, so probing tells them
  // nothing about which files exist.
  await assert.rejects(media.grant(stranger, id), { code: 'NOT_FOUND' });
  await assert.rejects(media.describe(stranger, id), { code: 'NOT_FOUND' });
  await assert.rejects(media.grant(stranger, 'med_AAAAAAAAAAAAAAAAAAAAAAAAAA'), { code: 'NOT_FOUND' });

  // Platform Ops with a reviewing capability may open it, and the look is
  // recorded — the decision to look, never the address handed out.
  const reviewer = { id: await newUser({ role: 'ops' }), role: 'ops', operator_id: null, platform_capabilities: ['verification'] };
  const reviewerGrant = await media.grant(reviewer, id);
  assert.ok(reviewerGrant.url);
  assert.equal(reviewerGrant.authorizedAs, 'platform');
  // Audited against the row's uuid, carrying the public id in the details: the
  // event stream keys on uuids, and a trail that cannot name what it audited
  // would not be a trail.
  const rowId = (await one('SELECT id FROM media WHERE media_id=$1', [id])).id;
  const audited = await many('SELECT action,details FROM audit_events WHERE entity_id=$1', [rowId]);
  const actions = audited.map(row => row.action);
  assert.equal(actions.filter(action => action === 'media.opened').length, 2, 'every open is recorded, one row each');
  assert.equal(actions.filter(action => action === 'media.stored').length, 1);
  assert.equal(audited.find(row => row.action === 'media.stored').details.mediaId, id);
  assert.ok(!JSON.stringify(audited).includes('X-Amz'), 'no address ever reaches the audit trail');

  // A platform identity with only an unrelated capability is refused.
  const unrelated = { id: await newUser({ role: 'ops' }), role: 'ops', operator_id: null, platform_capabilities: ['finance'] };
  await assert.rejects(media.grant(unrelated, id), { code: 'NOT_FOUND' });
});

test('a grant stops working when it expires, which a hosted link never could', async () => {
  let clock = Date.now();
  const store = memoryMediaStore({ now: () => clock });
  const { media } = await registry({ store });
  const owner = { id: await newUser(), role: 'passenger' };
  const { id } = await media.upload(owner, { purpose: 'driver_kyc', bytes: PDF });
  const grant = await media.grant(owner, id, { ttlSeconds: MEDIA_READ_TTL_SECONDS });
  assert.ok(store.resolve(grant.url));
  clock += (MEDIA_READ_TTL_SECONDS + 1) * 1000;
  assert.equal(store.resolve(grant.url), null, 'the grant expired');
});

test('deleting removes the object before the row, and refuses to claim otherwise', async () => {
  // A store that cannot delete must NOT let the platform record a deletion.
  const stuck = memoryMediaStore({ failRemove: true });
  const failing = await registry({ store: stuck });
  const ownerA = { id: await newUser(), role: 'passenger' };
  const first = await failing.media.upload(ownerA, { purpose: 'incident_evidence', bytes: PDF });
  await assert.rejects(failing.media.remove(ownerA, first.id));
  assert.equal((await one('SELECT status FROM media WHERE media_id=$1', [first.id])).status, 'stored',
    'the row still says stored, because it still is');

  const { store, media } = await registry();
  const owner = { id: await newUser(), role: 'passenger' };
  const { id } = await media.upload(owner, { purpose: 'incident_evidence', bytes: PDF });
  const key = (await one('SELECT object_key FROM media WHERE media_id=$1', [id])).object_key;
  await media.remove(owner, id);
  assert.equal(store.has(key), false, 'the bytes are gone');
  assert.equal((await one('SELECT status FROM media WHERE media_id=$1', [id])).status, 'deleted');
  // Idempotent: deleting twice is not an error.
  await media.remove(owner, id);
});

test('a caller may delete their own file and nobody else’s', async () => {
  const { media } = await registry();
  const owner = { id: await newUser(), role: 'passenger' };
  const stranger = { id: await newUser(), role: 'passenger' };
  const { id } = await media.upload(owner, { purpose: 'incident_evidence', bytes: PDF });
  await assert.rejects(media.remove(stranger, id), { code: 'NOT_FOUND' });
  // Not even a platform reviewer may delete somebody else's file from here:
  // removal is a retention decision, and the retention engine owns it.
  const reviewer = { id: await newUser({ role: 'ops' }), role: 'ops', operator_id: null, platform_capabilities: ['superadmin'] };
  await assert.rejects(media.remove(reviewer, id), { code: 'NOT_FOUND' });
});

test('an upload that dies leaves a row to find, not bytes nothing can find', async () => {
  const store = memoryMediaStore({ failPut: true });
  const { media } = await registry({ store });
  const owner = { id: await newUser(), role: 'passenger' };
  await assert.rejects(media.upload(owner, { purpose: 'incident_evidence', bytes: PDF }));
  // The row exists and says `pending`: the failure is visible to reconciliation
  // rather than being a silence, and there are no orphaned bytes.
  const orphan = await one('SELECT media_id,status FROM media WHERE owner_user_id=$1', [owner.id]);
  assert.equal(orphan.status, 'pending');
  assert.equal(store.keys().length, 0, 'and no bytes were left with nothing to find them by');
  const anomalies = await media.anomalies();
  assert.ok(anomalies.some(row => row.id === orphan.media_id), 'reconciliation can see it');
});

test('an object key cannot escape its bucket, whatever is written into it', async () => {
  const owner = await newUser();
  // Defence in depth: keys are generated here, but a key that could traverse
  // out of its bucket is only discovered after it has been used.
  for (const bad of ['../../etc/passwd', '/absolute', 'https://evil.invalid/x', '']) {
    await assert.rejects(
      db.transaction(async tx => tx.query(`INSERT INTO media(media_id,owner_user_id,subject_user_id,purpose,provider,bucket,object_key,
        content_type,byte_size,checksum_sha256) VALUES($1,$2,$2,'incident_evidence','memory','media',$3,'application/pdf',1,$4)`,
      [newMediaId(), owner, bad, 'a'.repeat(64)])),
      // The repository's transaction wrapper reports a constraint violation by
      // its SQLSTATE, never by the provider's message.
      { code: '23514' }, `key ${JSON.stringify(bad)} must be refused by the database`);
  }
});

test('the registry lists what a person owns, and never a key or a URL', async () => {
  const { media } = await registry();
  const owner = { id: await newUser(), role: 'passenger' };
  const other = { id: await newUser(), role: 'passenger' };
  await media.upload(owner, { purpose: 'incident_evidence', bytes: PDF });
  await media.upload(other, { purpose: 'incident_evidence', bytes: PDF });

  const mine = await media.mine(owner);
  assert.equal(mine.length, 1, 'only their own');
  const serialized = JSON.stringify(mine);
  assert.ok(!serialized.includes('object_key') && !serialized.includes('memory://') && !serialized.includes('X-Amz'),
    'whether a file exists is list information; where it lives is not');
});
