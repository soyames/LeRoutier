// Rotate the Backblaze application key LeRoutier uses for KYC evidence.
//
// WHY THIS EXISTS. Rotating by hand went wrong twice in one sitting. The B2
// console pre-ticks capabilities, so a key created there arrived with 19 of
// them — including writeBuckets and writeBucketLifecycleRules, either of which
// could make the KYC bucket public or delete its retention rule. And moving a
// secret by hand means the secret gets handled, which is how one ended up
// somewhere it should never have been. This script removes both steps: the
// capability set is fixed in code, and the secret goes from Backblaze straight
// into Vercel without passing through a shell, an argument, a file or a log.
//
//   node scripts/rotate-b2-key.mjs <path-to-master-credentials-file>
//
// The file is the owner's own Backblaze export and is read for two lines only.
// It is never copied, never printed, and must never enter this repository.
//
// AFTERWARDS the deployment still has to pick the new value up:
//   vercel redeploy <current-production-url>
//
// This script prints PASS/FAIL, capability NAMES and HTTP statuses. It never
// prints a key id, a secret, a token, or a signed URL.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const B2 = 'https://api.backblazeb2.com/b2api/v3';
const BUCKET = process.env.B2_BUCKET_NAME_HINT ?? 'leroutier-kyc-evidence-eu';
const KEY_NAME = 'leroutier-kyc-evidence-api';
const PROJECT = 'le-routier-api';
const TEAM = 'soyames-projects-fda10c02';

/**
 * Exactly what the adapter calls, and nothing more.
 *
 * put -> writeFiles, read -> shareFiles + readFiles, remove -> listFiles +
 * deleteFiles. A request handler has no business managing buckets or minting
 * further keys, so it cannot.
 */
const CAPABILITIES = ['listFiles', 'readFiles', 'writeFiles', 'deleteFiles', 'shareFiles'];

const credentialsFile = process.argv[2];
if (!credentialsFile || !fs.existsSync(credentialsFile)) {
  console.error('Usage: node scripts/rotate-b2-key.mjs <path-to-master-credentials-file>');
  console.error('The file is your Backblaze export. It is read, never copied or printed.');
  process.exit(2);
}

/** Find the account-level pair without knowing the file's exact layout. */
function masterCredentials(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim());
  const id = lines.find(l => /^[0-9a-f]{12}$/.test(l));
  const secret = lines.find(l => /^K00[0-9][A-Za-z0-9+/=_-]{20,}$/.test(l));
  return id && secret ? { id, secret } : null;
}

const authorize = async (id, secret) => {
  const r = await fetch(`${B2}/b2_authorize_account`,
    { headers: { authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') } });
  if (!r.ok) return null;
  const body = await r.json();
  return { token: body.authorizationToken, ...(body.apiInfo?.storageApi ?? body), accountId: body.accountId };
};
const call = async (s, p, payload) => {
  const r = await fetch(`${s.apiUrl}/b2api/v3/${p}`, {
    method: 'POST', headers: { authorization: s.token, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} ${r.status} ${json.code ?? ''}`);
  return json;
};

const vercelToken = () => {
  const file = path.join(process.env.APPDATA ?? process.env.HOME ?? '', 'com.vercel.cli', 'Data', 'auth.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')).token ?? null;
};
const vercel = async (token, method, url, body) => {
  const r = await fetch(`https://api.vercel.com${url}${url.includes('?') ? '&' : '?'}slug=${TEAM}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
};

const credentials = masterCredentials(credentialsFile);
if (!credentials) { console.error('FAIL  no account-level credential pair found in that file'); process.exit(1); }

const token = vercelToken();
if (!token) { console.error('FAIL  no Vercel CLI session found; run `vercel login` first'); process.exit(1); }

const master = await authorize(credentials.id, credentials.secret);
if (!master) { console.error('FAIL  that credential is not valid against Backblaze'); process.exit(1); }
const accountId = master.accountId;

const bucket = (await call(master, 'b2_list_buckets', { accountId, bucketName: BUCKET })).buckets?.[0];
if (!bucket) { console.error(`FAIL  bucket ${BUCKET} not found on this account`); process.exit(1); }
console.log(`INFO  bucket ${BUCKET}: ${bucket.bucketType}, cors=${JSON.stringify(bucket.corsRules)}`);

// Mint FIRST, verify, then remove the old one — never the other way round, so
// a failure half way leaves a working credential rather than none.
const minted = await call(master, 'b2_create_key', {
  accountId, keyName: KEY_NAME, bucketId: bucket.bucketId, capabilities: CAPABILITIES,
});
const granted = (minted.capabilities ?? []).slice().sort();
const exact = granted.length === CAPABILITIES.length && CAPABILITIES.every(c => granted.includes(c));
console.log(`${exact ? 'PASS' : 'FAIL'}  capabilities are exactly the five required: ${granted.join(', ')}`);
console.log(`${minted.bucketId === bucket.bucketId ? 'PASS' : 'FAIL'}  confined to the evidence bucket`);
if (!exact || minted.bucketId !== bucket.bucketId) {
  await call(master, 'b2_delete_key', { applicationKeyId: minted.applicationKeyId });
  console.error('FAIL  refused to install an incorrectly scoped key; it was deleted');
  process.exit(1);
}

const session = await authorize(minted.applicationKeyId, minted.applicationKey);
console.log(`${session ? 'PASS' : 'FAIL'}  new key authenticates`);
if (!session) { await call(master, 'b2_delete_key', { applicationKeyId: minted.applicationKeyId }); process.exit(1); }

// Round trip on a generated fixture. Never a real document, and nothing is left.
const key = `evidence/_rotation/${randomUUID()}`;
const fixture = new TextEncoder().encode('%PDF-1.4\n% ROTATION CHECK - generated, not a real document\n');
const upload = await call(session, 'b2_get_upload_url', { bucketId: bucket.bucketId });
const put = await fetch(upload.uploadUrl, {
  method: 'POST', body: fixture,
  headers: {
    authorization: upload.authorizationToken, 'x-bz-file-name': encodeURIComponent(key),
    'content-type': 'application/pdf', 'content-length': String(fixture.length),
    'x-bz-content-sha1': createHash('sha1').update(fixture).digest('hex'),
  },
});
console.log(`${put.ok ? 'PASS' : 'FAIL'}  can upload`);
const grant = await call(session, 'b2_get_download_authorization', {
  bucketId: bucket.bucketId, fileNamePrefix: key, validDurationInSeconds: 120, b2ContentDisposition: 'inline',
});
const url = `${session.downloadUrl}/file/${encodeURIComponent(BUCKET)}/${key.split('/').map(encodeURIComponent).join('/')}`
  + `?${new URLSearchParams({ Authorization: grant.authorizationToken, b2ContentDisposition: 'inline' })}`;
console.log(`${(await fetch(url)).status === 200 ? 'PASS' : 'FAIL'}  can open with a reviewer grant`);
console.log(`${(await fetch(url.split('?')[0])).status === 401 ? 'PASS' : 'FAIL'}  bucket is still private`);
for (const f of ((await call(session, 'b2_list_file_versions',
  { bucketId: bucket.bucketId, prefix: key, maxFileCount: 10 })).files ?? []).filter(f => f.fileName === key)) {
  await call(session, 'b2_delete_file_version', { fileName: f.fileName, fileId: f.fileId });
}
const left = ((await call(session, 'b2_list_file_versions',
  { bucketId: bucket.bucketId, prefix: key, maxFileCount: 10 })).files ?? []).filter(f => f.fileName === key).length;
console.log(`${left === 0 ? 'PASS' : 'FAIL'}  can delete, nothing left behind`);

// Install. The secret goes straight from Backblaze's response into Vercel.
const existing = (await vercel(token, 'GET', `/v10/projects/${PROJECT}/env`)).json.envs ?? [];
let installed = true;
for (const [name, value] of [['B2_KEY_ID', minted.applicationKeyId], ['B2_APPLICATION_KEY', minted.applicationKey]]) {
  for (const target of ['production', 'preview']) {
    const old = existing.find(e => e.key === name && (e.target ?? []).includes(target));
    if (old) await vercel(token, 'DELETE', `/v9/projects/${PROJECT}/env/${old.id}`);
    const created = await vercel(token, 'POST', `/v10/projects/${PROJECT}/env`,
      { key: name, value, type: 'sensitive', target: [target] });
    if (!created.ok) installed = false;
    console.log(`${created.ok ? 'PASS' : 'FAIL'}  ${name} -> ${target}`);
  }
}
if (!installed) { console.error('FAIL  not every variable was written; the OLD key has been left in place'); process.exit(1); }

// Only now is the previous key safe to remove.
let removed = 0;
for (const k of (await call(master, 'b2_list_keys', { accountId, maxKeyCount: 100 })).keys ?? []) {
  if (k.keyName === KEY_NAME && k.applicationKeyId !== minted.applicationKeyId) {
    await call(master, 'b2_delete_key', { applicationKeyId: k.applicationKeyId });
    removed++;
  }
}
console.log(`PASS  previous key(s) revoked: ${removed}`);
console.log('\nNEXT: redeploy so the running deployment picks the new value up:');
console.log('  vercel redeploy <current-production-url>');
console.log('Then confirm on Platform Ops -> Systeme -> Justificatifs KYC.');
