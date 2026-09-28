// The KYC journey end to end, against REAL object storage.
//
// Every other proof of this path runs against a fake HTTP harness, and that is
// the right default: CI has no storage credential and must not reach a vendor.
// It leaves exactly one question unasked — does the real endpoint accept what
// this code sends, and does it refuse what it should? This file asks it, against
// Neon Object Storage.
//
// It SKIPS unless S3 credentials are in the environment, so the suite stays
// green in CI and remains runnable for whoever holds them:
//
//   S3_ENDPOINT=… S3_REGION=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
//     pnpm --filter @leroutier/api test
//
// SAFETY, in three layers.
//   The database half runs in a disposable lr_test_* schema and is dropped. No
//   seeding or demo session is ever pointed at production — the guards refuse
//   it independently of this file.
//   The storage half refuses any bucket whose name does not contain "test",
//   creates that bucket itself, and empties and deletes it afterwards. It
//   cannot reach the production buckets.
//   Nothing here prints a credential.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { serverConfig, authConfig, publicAuthConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { seedTestTransport } from '@leroutier/database/test-transport';
import { retentionEngine } from '@leroutier/database/privacy';
import { evidenceStore } from '@leroutier/database/evidence-storage';
import { signRequest, amzDate } from '@leroutier/database/s3-storage';
import { createApi } from '../src/app.js';
import { jwtFixture } from './jwt-fixture.js';

const s3 = {
  endpoint: (process.env.S3_ENDPOINT ?? '').replace(/\/+$/, ''),
  region: process.env.S3_REGION,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  service: process.env.S3_SERVICE || 's3',
};
const BUCKET = 'leroutier-evidence-test';
const skip = s3.endpoint && s3.region && s3.accessKeyId && s3.secretAccessKey
  ? false
  : 'no S3 credentials in the environment (set S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)';

const base = serverConfig();
const config = { ...base, schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true,
  // Spread rather than replace: the KYC block keeps whatever else it carries,
  // and only the provider and its bucket are pointed at the test arrangement.
  evidenceStorage: { ...base.evidenceStorage, provider: 'neon', bucket: BUCKET }, objectStorage: { s3 } };
const db = createDatabase(config);

// A generated PDF header. Never a real document, and never anybody's.
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const objectUrl = key => `${s3.endpoint}/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

/** A complete independent-onboarding submission. Every reference is a valid
 * https URL, because the validator refuses anything else — written out in full
 * because an incomplete body is rejected as a bad request before any role check
 * happens, and would prove nothing about authorization. */
const ONBOARD_BODY = {
  displayName: 'TEST KYC Operator', phone: '+22990000000', country: 'bj',
  idDocumentType: 'national_id', idDocumentReference: 'TEST-ID-REF',
  licenseReference: 'TEST-LICENCE-REF', transportAuthorizationReference: 'TEST-AUTH-REF',
  insuranceReference: 'TEST-INS-REF', roadworthinessReference: 'TEST-ROAD-REF',
  vehicleRegistration: 'TEST-REG-001', vehicleCapacity: 4,
  vehicleMake: 'TEST', vehicleModel: 'Hiace', vehicleColor: 'Blanc',
  idDocumentUrl: 'https://example.invalid/id.pdf', licenseDocumentUrl: 'https://example.invalid/licence.pdf',
  transportAuthorizationDocumentUrl: 'https://example.invalid/auth.pdf',
  insuranceDocumentUrl: 'https://example.invalid/ins.pdf',
  roadworthinessDocumentUrl: 'https://example.invalid/road.pdf',
  vehicleRegistrationDocumentUrl: 'https://example.invalid/reg.pdf',
  driverPhotoUrl: 'https://example.invalid/photo.jpg',
};

let api, fixture, operatorToken, reviewerToken, operatorId, store;

/** Bucket administration, done here rather than in the production store: a
 * store that can rewrite a bucket's access is a store that can publish a
 * passport. */
async function bucketRequest(method, path = '') {
  const url = `${s3.endpoint}/${BUCKET}${path}`;
  const parsed = new URL(url);
  const headers = { host: parsed.host };
  const payloadHash = sha256('');
  const date = new Date();
  const { authorization } = signRequest({ method, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams),
    headers, payloadHash, region: s3.region, service: s3.service,
    accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, date });
  return fetch(url, { method, headers: { ...headers, authorization, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(date) } });
}

async function listKeys() {
  const body = await (await bucketRequest('GET', '?list-type=2')).text();
  return [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map(match => match[1]);
}

/** @param {string} path @param {{method?:string, bearer?:string|null, body?:any, headers?:object, raw?:boolean}} [options] */
const call = (path, { method = 'GET', bearer = null, body, headers = {}, raw = false } = {}) =>
  api(new Request('http://localhost/api/v1' + path, {
    method,
    headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(raw ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  }));

/**
 * The payload of a successful call.
 *
 * The body is read exactly once — an assertion message that reads it to be
 * helpful consumes the stream, and the next read throws "Body is unusable",
 * which looks like a product failure and is not.
 */
async function data(response) {
  const text = await response.text();
  assert.ok(response.ok, `expected success, got ${response.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text).data;
}

before(async () => {
  if (skip) return;
  assert.match(BUCKET, /test/, 'the test bucket must name itself a test bucket');
  await bucketRequest('PUT');
  await migrate(db);
  await seedTestTransport(db);
  fixture = await jwtFixture();
  Object.assign(config, { issuer: fixture.config.issuer, audience: fixture.config.audience, jwksUrl: fixture.config.jwksUrl });
  api = createApi(db, config, fixture.resolver);
  // The same store the API built, for the retention engine: deletion is driven
  // by the scan, not by an endpoint.
  store = evidenceStore(config);
});

after(async () => {
  if (skip) return;
  try {
    // Leaves the bucket empty so it can be removed, whether or not the run
    // finished. Anything left behind would leak into the next run.
    for (const key of await listKeys()) await bucketRequest('DELETE', '/' + key.split('/').map(encodeURIComponent).join('/'));
    await bucketRequest('DELETE');
  } finally {
    try { await dropDisposableSchema(db); } finally { await db.close(); }
  }
});

test('production demo login and the Firebase identity path are unchanged', () => {
  // The rule is a pure function of the environment, so it is asserted directly
  // rather than inferred from a deployment. Each guard is checked on its own:
  // either one is enough to keep demo login out of production.
  const identifiers = { FIREBASE_PROJECT_ID: 'example', FIREBASE_API_KEY: 'k', FIREBASE_AUTH_DOMAIN: 'd', FIREBASE_APP_ID: 'a' };
  const production = { ...identifiers, ALLOW_DEMO_LOGIN: 'true', VERCEL: '1', NODE_ENV: 'production' };
  assert.equal(authConfig(production).demoLogin, false, 'Vercel and NODE_ENV=production together');
  assert.equal(authConfig({ ...production, NODE_ENV: 'development' }).demoLogin, false, 'Vercel alone is enough');
  assert.equal(authConfig({ ...production, VERCEL: undefined }).demoLogin, false, 'NODE_ENV=production alone is enough');
  assert.equal(authConfig({ ...production, ALLOW_DEMO_LOGIN: undefined }).demoLogin, false, 'and it is opt-in to begin with');
  assert.equal(authConfig({ ALLOW_DEMO_LOGIN: 'true', NODE_ENV: 'development' }).demoLogin, true,
    'still available locally, which is what the disposable suites rely on');
  // Firebase Authentication itself is untouched: the same public identifiers,
  // and nothing else, are what the browser is given.
  const firebase = publicAuthConfig(authConfig({ ...production, ALLOW_DEMO_LOGIN: undefined })).firebase;
  assert.deepEqual(Object.keys(firebase).sort(), ['apiKey', 'appId', 'authDomain', 'projectId', 'providers']);
});

test('an operator, a reviewer, and a real document: KYC end to end on live storage', { skip }, async () => {
  // ---------------------------------------------------------------- roles --
  // The operator is a REAL identity — a signed provider token, exactly the path
  // /me uses — because onboarding refuses demo accounts by design. The reviewer
  // is a seeded demo identity, which platform routes accept.
  operatorToken = await fixture.sign('kyc-operator-' + randomUUID(), {
    email: 'kyc-operator@example.invalid', email_verified: true, firebase: { sign_in_provider: 'password' },
  });
  reviewerToken = (await data(await call('/auth/demo', { method: 'POST', body: { profile: 'platform-ops' } }))).token;

  assert.equal((await call('/me', { bearer: operatorToken })).status, 200, 'the new identity is provisioned');
  await data(await call('/me', { method: 'PATCH', bearer: operatorToken,
    body: { displayName: 'TEST KYC Operator', phone: '+22990000000' } }));

  // A demo identity cannot start this journey. That is precisely why a real
  // identity is used above, and it is asserted rather than assumed.
  const demoOperatorToken = (await data(await call('/auth/demo', { method: 'POST', body: { profile: 'owner-driver' } }))).token;
  const refused = await call('/onboarding/independent', { method: 'POST', bearer: demoOperatorToken,
    headers: { 'idempotency-key': randomUUID() }, body: { ...ONBOARD_BODY, displayName: 'TEST Demo' } });
  assert.equal(refused.status, 403, 'a demo identity may not onboard');
  assert.equal((await refused.json()).error.code, 'FORBIDDEN');

  // --------------------------------------------------------------- onboard --
  const started = await data(await call('/onboarding/independent', { method: 'POST', bearer: operatorToken,
    headers: { 'idempotency-key': randomUUID() }, body: ONBOARD_BODY }));
  operatorId = started.operatorId;
  assert.equal(started.status, 'pending_verification', 'a new dossier is opened for review, never auto-approved');

  const dossier = await data(await call('/onboarding/evidence', { bearer: operatorToken }));
  const identity = dossier.evidence.find(entry => entry.kind === 'identity');
  assert.ok(identity, 'the onboarding file carries the proofs the operator submitted');
  assert.equal(identity.storage, 'operator_link', 'nothing is managed until LeRoutier is given the bytes');

  // ---------------------------------------------------------------- refuse --
  // The route carries the command under `decision`, so one endpoint can review
  // a single proof or decide the whole dossier.
  await data(await call(`/operators/${operatorId}/verification`, { method: 'POST', bearer: reviewerToken,
    body: { decision: { type: 'evidence', evidenceId: identity.id, status: 'rejected', notes: 'TEST illisible' } } }));

  // ---------------------------------------------------------- upload, live --
  const stored = await data(await call(`/onboarding/evidence/${identity.id}/file`, { method: 'POST', bearer: operatorToken,
    body: PDF, raw: true, headers: { 'content-type': 'application/pdf' } }));
  assert.equal(stored.content_type, 'application/pdf', 'the type is read from the bytes, not declared');
  assert.equal(Number(stored.byte_size), PDF.length);

  const row = (await db.transaction(async tx => (await tx.query(
    'SELECT storage_key,storage_provider,content_type,byte_size,file_url FROM verification_evidence WHERE id=$1', [identity.id])).rows))[0];
  assert.equal(row.storage_provider, 'neon', 'the row names the provider that actually holds it');
  assert.match(row.storage_key, /^evidence\/[0-9a-f-]{36}\/identity\/[0-9a-f-]{36}$/);
  assert.equal(row.file_url, null, 'and the operator-hosted link is cleared, never left pointing elsewhere');
  // It is really in the bucket, not merely recorded as such.
  assert.ok((await listKeys()).includes(row.storage_key), 'the object exists in live storage');

  // -------------------------------------------------------- reviewer grant --
  const grant = await data(await call(`/ops/evidence/${identity.id}/access`, { bearer: reviewerToken }));
  assert.equal(grant.storage, 'managed');
  assert.ok(Date.parse(grant.expiresAt) > Date.now(), 'a grant that expires, unlike a hosted link');

  const opened = await fetch(grant.url);
  const back = new Uint8Array(await opened.arrayBuffer());
  assert.equal(opened.status, 200);
  assert.equal(back.length, PDF.length);
  assert.equal(sha256(back), sha256(PDF), 'the reviewer opens the exact bytes that were uploaded');

  // ------------------------------------------------- the property that matters --
  // Not merely unguessable: genuinely unreachable without a grant.
  const anonymous = await fetch(objectUrl(row.storage_key));
  assert.ok(anonymous.status >= 400, `an unauthenticated caller must not read it (got ${anonymous.status})`);

  // ------------------------------------------------------------ replacement --
  // Uploading a proof returns it to the review queue, so replacing it a second
  // time means being refused a second time. That is the rule, not a shortcut
  // around it — and it is asserted here rather than engineered past.
  const tooSoon = await call(`/onboarding/evidence/${identity.id}/file`, { method: 'POST', bearer: operatorToken,
    body: PDF, raw: true, headers: { 'content-type': 'application/pdf' } });
  assert.equal(tooSoon.status, 409, 'a proof already awaiting review cannot be replaced again');
  await data(await call(`/operators/${operatorId}/verification`, { method: 'POST', bearer: reviewerToken,
    body: { decision: { type: 'evidence', evidenceId: identity.id, status: 'rejected', notes: 'TEST encore illisible' } } }));

  const second = new Uint8Array([...PDF, 0x0A, 0x25, 0x54, 0x45, 0x53, 0x54]);
  await data(await call(`/onboarding/evidence/${identity.id}/file`, { method: 'POST', bearer: operatorToken,
    body: second, raw: true, headers: { 'content-type': 'application/pdf' } }));
  const current = (await db.transaction(async tx => (await tx.query(
    'SELECT storage_key FROM verification_evidence WHERE id=$1', [identity.id])).rows))[0].storage_key;
  assert.notEqual(current, row.storage_key, 'a new object, never an overwrite');
  assert.ok(!(await listKeys()).includes(row.storage_key), 'the document it replaced is gone from storage');

  // --------------------------------------------------- retention deletion --
  // The real deletion path: a refused dossier past its retention window. The
  // object goes first, and only then are the row's pointers cleared.
  await data(await call(`/operators/${operatorId}/verification`, { method: 'POST', bearer: reviewerToken, body: { decision: 'rejected' } }));
  await db.transaction(async tx => tx.query("UPDATE operators SET created_at=now()-interval '120 days' WHERE id=$1", [operatorId]));
  const scan = await retentionEngine(db, store).run({ execute: true });
  assert.equal(scan.dryRun, false, 'an explicit execute is not a dry run');
  const kyc = scan.report.find(entry => entry.category === 'kyc_evidence');
  assert.ok(kyc, 'the scan reports on the KYC category at all');
  assert.ok(kyc.eligible >= 1, `the refused dossier was not eligible for retention: ${JSON.stringify(kyc)}`);
  assert.equal(kyc.executed, true, 'and it was actually actioned, not merely listed');

  assert.ok(!(await listKeys()).includes(current), 'the bytes are gone from the bucket');
  const forgotten = (await db.transaction(async tx => (await tx.query(
    'SELECT storage_key,file_url,redacted_at FROM verification_evidence WHERE id=$1', [identity.id])).rows))[0];
  assert.equal(forgotten.storage_key, null, 'and the pointer is cleared only once the object is gone');
  assert.ok(forgotten.redacted_at, 'the row records that it was deliberately forgotten');
  assert.deepEqual(await listKeys(), [], 'nothing this suite created is left in the bucket');
});
