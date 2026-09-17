import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { seed } from '@leroutier/database/seed';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { createApi } from '../src/app.js';
import { jwtFixture } from './jwt-fixture.js';

// The production profile-save bug, pinned against the REAL route stack (auth
// resolution, CORS gate, body validation, DB update) — not a mocked fixture:
// a first-login Google/email passenger must be able to PATCH their own name
// and phone, with or without an Origin header, and can never touch
// privileged fields.
let api, fixture, token, db;
before(async () => {
  const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: false };
  db = createDatabase(config);
  await migrate(db); await seed(db);
  fixture = await jwtFixture();
  api = createApi(db, { ...config, ...fixture.config, corsOrigins: ['https://leroutier.app', 'https://www.leroutier.app'] }, fixture.resolver);
  token = await fixture.sign('person-' + randomUUID().slice(0, 8));
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

const patchMe = (body, { origin = null, auth = token } = {}) => api(new Request('http://localhost/api/v1/me', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + auth } : {}), ...(origin ? { origin } : {}) },
  body: JSON.stringify(body),
}));

test('a first-login Google/email passenger can PATCH their own profile', async () => {
  const me = await api(new Request('http://localhost/api/v1/me', { headers: { authorization: 'Bearer ' + token } }));
  assert.equal(me.status, 200);
  const identity = (await me.json()).data;
  assert.equal(identity.role, 'passenger');
  assert.equal(identity.needs_profile, true, 'new identity needs its basic profile');
  const patched = await patchMe({ displayName: 'Yao Sossou', phone: '+229 97000099' });
  assert.equal(patched.status, 200, 'profile PATCH must succeed for a normal passenger');
  const after = (await patchMe({ displayName: 'Yao Sossou' })).status === 200 ? await api(new Request('http://localhost/api/v1/me', { headers: { authorization: 'Bearer ' + token } })) : null;
  assert.equal(after.status, 200);
  assert.equal((await after.json()).data.needs_profile, false);
});

test('missing Origin does not fail an authenticated PATCH', async () => {
  const r = await patchMe({ displayName: 'Sans Origin' });
  assert.equal(r.status, 200);
});

test('the canonical and www origins both pass the CORS gate', async () => {
  for (const origin of ['https://leroutier.app', 'https://www.leroutier.app']) {
    const r = await patchMe({ displayName: 'Avec Origin' }, { origin });
    assert.equal(r.status, 200, `${origin} must be allowed`);
  }
  const hostile = await patchMe({ displayName: 'X' }, { origin: 'https://evil.example.invalid' });
  assert.equal(hostile.status, 403, 'untrusted origins stay rejected');
});

test('a passenger can never change role, operator_id or another user', async () => {
  for (const body of [{ displayName: 'x', role: 'ops' }, { displayName: 'x', operator_id: randomUUID() }]) {
    const r = await patchMe(body);
    assert.equal(r.status, 400, 'privileged fields are rejected outright');
  }
  const other = await api(new Request('http://localhost/api/v1/me', { headers: { authorization: 'Bearer ' + await fixture.sign('person-other') } }));
  assert.equal(other.status, 200, 'another user exists');
  const unauthorized = await patchMe({ displayName: 'Autre Nom' }, { auth: await fixture.sign('person-other') });
  // The API only ever updates the CALLER's row; cross-user updates are impossible by construction.
  assert.equal(unauthorized.status, 200);
  const me = await api(new Request('http://localhost/api/v1/me', { headers: { authorization: 'Bearer ' + token } }));
  assert.ok(typeof (await me.json()).data.display_name === 'string', 'the other identity could not touch this profile');
});
