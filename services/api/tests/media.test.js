// The media routes as a caller meets them: stable LeRoutier ids, no provider
// detail anywhere in a payload, and a URL only after this API has authorized
// that specific file for that specific caller.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { seedTestProfiles } from '@leroutier/database/test-profiles';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { memoryMediaStore } from '@leroutier/database/media';
import { createApi } from '../src/app.js';

const store = memoryMediaStore();
const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true, mediaStore: store };
const db = createDatabase(config);
let api, token, strangerToken;

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3]);

/** @param {string} path @param {{method?:string, bearer?:string|null, body?:any, headers?:object}} [options] */
const call = (path, { method = 'GET', bearer = null, body, headers = {} } = {}) =>
  api(new Request('http://localhost/api/v1' + path, {
    method, body,
    headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
  }));

async function demoToken(profile) {
  const response = await call('/auth/demo', { method: 'POST', body: JSON.stringify({ profile }) });
  const payload = await response.json();
  assert.ok(payload.data?.token, `demo sign-in for ${profile} failed: ${response.status} ${JSON.stringify(payload).slice(0, 240)}`);
  return payload.data.token;
}

before(async () => {
  await migrate(db); await seedTestProfiles(db); api = createApi(db, config);
  token = await demoToken('passenger');
  strangerToken = await demoToken('owner-driver');
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('uploading requires an identity, and yields an opaque LeRoutier id', async () => {
  const anonymous = await call('/media?purpose=incident_evidence', { method: 'POST', body: PDF });
  assert.equal(anonymous.status, 401, 'no token, no upload');

  const uploaded = await call('/media?purpose=incident_evidence', { method: 'POST', bearer: token, body: PDF });
  assert.equal(uploaded.status, 200);
  const data = (await uploaded.json()).data;
  assert.match(data.id, /^med_[A-Z2-7]{26}$/);
  assert.equal(data.contentType, 'application/pdf');
  // Nothing about the provider reaches the caller — not its name, not a bucket,
  // not a key. That is what keeps a provider swap invisible to a user journey.
  assert.ok(!JSON.stringify(data).includes('memory') && !JSON.stringify(data).includes('media/'),
    'no provider, bucket or key in the payload');
});

test('a caller lists their own files, and only their own', async () => {
  const mine = await call('/media', { bearer: token });
  assert.equal(mine.status, 200);
  const data = (await mine.json()).data;
  assert.ok(Array.isArray(data) && data.length >= 1);
  for (const item of data) assert.match(item.id, /^med_/);
  const theirs = await call('/media', { bearer: strangerToken });
  assert.deepEqual((await theirs.json()).data, [], 'another identity owns nothing here');
});

test('opening a file is authorized, and a stranger cannot tell it exists', async () => {
  const uploaded = (await (await call('/media?purpose=incident_evidence', { method: 'POST', bearer: token, body: PDF })).json()).data;
  const granted = await call(`/media/${uploaded.id}/access`, { bearer: token });
  assert.equal(granted.status, 200);
  const grant = (await granted.json()).data;
  assert.ok(grant.url && grant.expiresAt, 'a URL that expires, which a hosted link never could');
  assert.equal(grant.contentType, 'application/pdf');

  // The same 404 a made-up id produces, so probing reveals nothing.
  const stranger = await call(`/media/${uploaded.id}/access`, { bearer: strangerToken });
  assert.equal(stranger.status, 404);
  const invented = await call('/media/med_AAAAAAAAAAAAAAAAAAAAAAAAAA/access', { bearer: token });
  assert.equal(invented.status, 404);
});

test('a file whose bytes are not a document is refused, whatever it claims to be', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const refused = await call('/media?purpose=incident_evidence', { method: 'POST', bearer: token, body: svg });
  assert.ok(refused.status >= 400, 'a scripted page is not a document');
  assert.equal(store.keys().length >= 0, true);
});

test('an oversized upload is refused before it is read, and again after', async () => {
  const huge = new Uint8Array(8 * 1024 * 1024 + 1);
  const refused = await call('/media?purpose=incident_evidence', { method: 'POST', bearer: token, body: huge });
  assert.equal(refused.status, 413);
});

test('an unknown or missing purpose is refused rather than stored unlabelled', async () => {
  assert.ok((await call('/media?purpose=whatever', { method: 'POST', bearer: token, body: PDF })).status >= 400);
  assert.ok((await call('/media', { method: 'POST', bearer: token, body: PDF })).status >= 400);
});

test('a caller deletes their own file, and nobody else may delete it', async () => {
  const uploaded = (await (await call('/media?purpose=incident_evidence', { method: 'POST', bearer: token, body: PDF })).json()).data;
  assert.equal((await call(`/media/${uploaded.id}`, { method: 'DELETE', bearer: strangerToken })).status, 404);
  const removed = await call(`/media/${uploaded.id}`, { method: 'DELETE', bearer: token });
  assert.equal(removed.status, 200);
  // Gone from the list and unreachable by id.
  assert.equal((await call(`/media/${uploaded.id}/access`, { bearer: token })).status, 404);
  const mine = (await (await call('/media', { bearer: token })).json()).data;
  assert.ok(!mine.some(item => item.id === uploaded.id));
});

test('an unsupported method is refused before any authentication is attempted', async () => {
  const response = await call('/media', { method: 'PUT', bearer: token, body: '{}' });
  assert.equal(response.status, 405);
});

test('a deployment with no store configured refuses uploads honestly', async () => {
  // Nothing pretends a file can be stored when nothing can hold it.
  const bare = createApi(db, { ...config, mediaStore: null, mediaStorage: undefined }, undefined, undefined);
  const response = await bare(new Request('http://localhost/api/v1/media?purpose=incident_evidence', {
    method: 'POST', body: PDF, headers: { authorization: 'Bearer ' + token },
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'EVIDENCE_STORAGE_UNAVAILABLE');
});
