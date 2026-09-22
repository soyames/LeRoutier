import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { seed, demoId } from '@leroutier/database/seed';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { DomainError } from '@leroutier/domain';
import { createApi } from '../src/app.js';

// Public API surface audit, mechanically: every endpoint classified by who may
// call it, and each class proven here — root minimalism, 401/403 boundaries,
// 405 methods, body limits, safe error bodies, and webhook signature gating.
const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
let api, passengerToken, opsToken;
let SECOND_OPERATOR, SECOND_OPS_USER, SECOND_DRIVER, DEMO_OPERATOR;
const SECOND_LICENCE = 'LICENCE-NEVER-DISCLOSED';

/** @param {{method?:string,token?:string|null,body?:unknown,headers?:Record<string,string>}} [opts] */
const call = (path, opts = {}) => { const { method = 'GET', token = null, body, headers = {} } = opts;
  return api(new Request('http://localhost/api/v1' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })); };

test('the API root reveals nothing', async () => {
  // Unknown paths are indistinguishable from private ones: both answer a
  // minimal JSON error with no internals, never a stack, SQL or topology.
  for (const path of ['/', '/api/v1', '/favicon.ico', '/unknown/deep/path']) {
    const r = await call(path);
    assert.ok([401, 404].includes(r.status), `${path} must answer minimally, got ${r.status}`);
    const text = await r.text();
    assert.ok(!/stack|sql|postgres|neon|vercel|migration|schema|at /i.test(text), `${path} leaks internals`);
  }
});

test('private endpoints require authentication', async () => {
  for (const path of ['/me', '/me/bookings', '/me/parcels', '/notifications', '/operator/settlements', '/ops/fleet', '/ops/model-usage', '/ops/health', '/workflows']) {
    const r = await call(path);
    assert.equal(r.status, 401, `${path} must require authentication`);
  }
});

test('role-restricted endpoints reject wrong roles', async () => {
  const r = await call('/ops/fleet', { token: passengerToken });
  assert.equal(r.status, 403);
  const h = await call('/ops/health', { token: passengerToken });
  assert.equal(h.status, 403);
  const m = await call('/ops/model-health', { method: 'POST', token: passengerToken, body: {} });
  assert.equal(m.status, 403);
});

test('cross-operator access is denied at the API boundary', async () => {
  // A parcel that belongs to the second operator.
  const rows = await db.transaction(async tx => (await tx.query(
    `INSERT INTO parcels(tracking_number,operator_id,origin_stop_id,destination_stop_id,category,quantity,price_minor,status,idempotency_key,request_fingerprint)
     VALUES('LRP-CROSS001',$1,$2,$3,'documents',1,1000,'created',$4,$5) RETURNING id`,
    [SECOND_OPERATOR, demoId(200), demoId(201), randomUUID(), 'fp-cross'])).rows);
  const r = await call(`/parcels/${rows[0].id}`, { token: opsToken });
  assert.equal(r.status, 403, 'demo ops cannot read another operator’s parcel');
});

test('an operator roster is never readable by someone outside that operator', async () => {
  // Regression: the guard was "refuse when the caller belongs to ANOTHER
  // operator", which every passenger satisfies by belonging to none. A plain
  // passenger could read any operator's crew list — driving licence
  // references included — by naming the operator id from a public search.
  const passenger = await call(`/operators/${SECOND_OPERATOR}/members`, { token: passengerToken });
  assert.equal(passenger.status, 403, 'a passenger has no operator roster');
  assert.ok(!(await passenger.text()).includes(SECOND_LICENCE), 'the licence reference never travels');
  const other = await call(`/operators/${SECOND_OPERATOR}/members`, { token: opsToken });
  assert.equal(other.status, 403, 'one operator never reads another operator’s roster');
  const own = await call(`/operators/${DEMO_OPERATOR}/members`, { token: opsToken });
  assert.equal(own.status, 200, 'an operator still reads its own roster');
});

test('an operator station register is never readable by someone outside that operator', async () => {
  const passenger = await call(`/operators/${SECOND_OPERATOR}/stations`, { token: passengerToken });
  assert.equal(passenger.status, 403, 'a passenger has no operator station register');
  const other = await call(`/operators/${SECOND_OPERATOR}/stations`, { token: opsToken });
  assert.equal(other.status, 403, 'one operator never reads another operator’s stations');
  const own = await call(`/operators/${DEMO_OPERATOR}/stations`, { token: opsToken });
  assert.equal(own.status, 200, 'an operator still reads its own stations');
});

test('an unidentifiable caller is refused, never treated as the actor', async () => {
  // Regression: only a DomainError counted as "not signed in". Any other
  // failure — a driver-level database error during identity resolution —
  // became the actor object itself, and /me answered 200 with the provider's
  // internals (schema, table, constraint, source routine) as the payload.
  const broken = { code: '23505', severity: 'ERROR', detail: 'Key (auth_subject)=(secret-subject) already exists.',
    schema: 'leroutier', table: 'users', constraint: 'users_auth_subject_key', file: 'nbtinsert.c', routine: '_bt_check_unique' };
  /** @type {any} */
  const failing = { ...db, transaction: () => Promise.reject(Object.assign(new Error('identity resolution failed'), broken)) };
  const failingApi = createApi(failing, config);
  const r = await failingApi(new Request('http://localhost/api/v1/me', { headers: { authorization: 'Bearer ' + passengerToken } }));
  assert.ok(r.status >= 400, `an unidentified caller must be refused, got ${r.status}`);
  const text = await r.text();
  for (const internal of ['nbtinsert', 'users_auth_subject_key', '_bt_check_unique', 'secret-subject', 'leroutier']) {
    assert.ok(!text.includes(internal), `${internal} must never reach the caller`);
  }
});

test('public search exposes only public product fields', async () => {
  const r = await call('/services');
  assert.equal(r.status, 200);
  const payload = await r.json();
  const text = JSON.stringify(payload);
  assert.ok(!/phone|email|auth_subject|password|token|secret/i.test(text), 'no private fields in the public catalogue');
});

test('public parcel lookup answers 404 uniformly without disclosure', async () => {
  // Well-formed unknown references answer 404; malformed ones never resolve
  // to the handler at all. Either way, nothing is disclosed.
  const unknown = await call('/public/parcel-tracking/LRP-FFFFFFFF');
  assert.equal(unknown.status, 404);
  const malformed = await call('/public/parcel-tracking/LRP-0000000');
  assert.ok([401, 404].includes(malformed.status), 'malformed references never reach the handler');
});

test('known endpoints reject unexpected methods with 405', async () => {
  for (const [path, method] of [['/health', 'POST'], ['/services', 'DELETE'], ['/webhooks/fedapay', 'GET'], ['/assistant', 'GET'], ['/auth/demo', 'PATCH']]) {
    const r = await call(path, { method });
    assert.equal(r.status, 405, `${method} ${path} must be 405`);
  }
});

test('malformed and oversized bodies are rejected before any processing', async () => {
  const noJson = await api(new Request('http://localhost/api/v1/assistant', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello',
  }));
  assert.equal(noJson.status, 400);
  const huge = await call('/assistant', { method: 'POST', body: { sessionId: 'test-session-0001', message: 'x'.repeat(17_000) } });
  assert.equal(huge.status, 413);
});

test('error responses never echo the caller’s token or internals', async () => {
  const token = 'super-secret-bearer-value';
  const r = await call('/me', { token });
  assert.equal(r.status, 401);
  const text = await r.text();
  assert.ok(!text.includes(token), 'the token is never echoed');
  assert.ok(!text.includes('at '), 'no stack traces in responses');
});

test('the webhook only accepts POST, fails closed on bad signatures, and ignores foreign events', async () => {
  /** @type {any} */
  const stub = {
    name: 'fedapay', payoutsAvailable: true,
    verifyEvent: async (raw) => {
      if (!raw.startsWith('{')) throw new DomainError('INVALID_SIGNATURE', 'Webhook signature is invalid.', 401);
      const parsed = JSON.parse(raw);
      if (parsed.kind === 'foreign') return null;
      return parsed;
    },
  };
  const webhookApi = createApi(db, config, undefined, stub);
  const post = (raw, headers = {}) => webhookApi(new Request('http://localhost/api/v1/webhooks/fedapay', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw,
  }));
  const head = await webhookApi(new Request('http://localhost/api/v1/webhooks/fedapay', { method: 'HEAD' }));
  assert.equal(head.status, 405, 'HEAD is refused');
  const bad = await post('not json at all');
  assert.equal(bad.status, 401, 'a bad signature fails closed');
  const foreign = await post(JSON.stringify({ kind: 'foreign' }));
  assert.equal(foreign.status, 200);
  assert.deepEqual(await foreign.json(), { data: { ignored: true } }, 'unknown events are safely ignored');
  const unconfigured = createApi(db, config);
  const unavailable = await unconfigured(new Request('http://localhost/api/v1/webhooks/fedapay', { method: 'POST', body: '{}' }));
  assert.equal(unavailable.status, 503, 'without a configured provider the webhook is unavailable, never open');
});

// ---- setup --------------------------------------------------------------
import { before, after } from 'node:test';
before(async () => {
  await migrate(db); await seed(db);
  SECOND_OPS_USER = demoId(41);
  SECOND_OPERATOR = demoId(40);
  SECOND_DRIVER = demoId(42);
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Régulation Opérateur B','ops') ON CONFLICT DO NOTHING`, [SECOND_OPS_USER]);
    await tx.query(`INSERT INTO operators(id,name,type,verification_status,owner_user_id) VALUES($1,'Second Opérateur','independent','verified',$2) ON CONFLICT DO NOTHING`, [SECOND_OPERATOR, SECOND_OPS_USER]);
    await tx.query(`UPDATE users SET operator_id=$2 WHERE id=$1`, [SECOND_OPS_USER, SECOND_OPERATOR]);
    // A crew member of the second operator, carrying the one field a roster
    // leak would hand out: a government driving licence reference.
    await tx.query(`INSERT INTO users(id,display_name,role,operator_id) VALUES($1,'Chauffeur Opérateur B','driver',$2) ON CONFLICT DO NOTHING`, [SECOND_DRIVER, SECOND_OPERATOR]);
    await tx.query(`INSERT INTO driver_profiles(user_id,operator_id,license_reference,active) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING`, [SECOND_DRIVER, SECOND_OPERATOR, SECOND_LICENCE]);
    DEMO_OPERATOR = (await tx.query(`SELECT operator_id FROM users WHERE is_demo=true AND role='ops' AND operator_id IS NOT NULL LIMIT 1`)).rows[0]?.operator_id;
  });
  api = createApi(db, config);
  for (const role of ['passenger', 'ops']) {
    const r = await api(new Request('http://localhost/api/v1/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) }));
    const token = (await r.json()).data.token;
    if (role === 'passenger') passengerToken = token;
    if (role === 'ops') opsToken = token;
  }
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });
