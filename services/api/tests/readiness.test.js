// Schema drift must be visible before a user meets it.
//
// On 2026-09-22 production ran code that expected 33 migrations against a
// database holding 19. `/health` answered 200 for the entire outage, because
// the process was alive and the database was reachable — both true, and both
// beside the point. Every authenticated request returned 503 with PostgreSQL
// 42703, undefined_column, the moment identity resolution touched a column
// fourteen migrations in the future.
//
// These tests reproduce that exact shape and assert the new signal catches it:
// liveness stays green, readiness turns red, and readiness is the one a
// deployment gate reads.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@leroutier/database';
import { migrate, declaredMigrations, schemaStatus } from '@leroutier/database/migrations';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { bootstrap } from '@leroutier/database/provisioning';
import { serverConfig } from '@leroutier/config';
import { createApi } from '../src/app.js';
import { jwtFixture } from './jwt-fixture.js';

const db = createDatabase({ ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', '') });
let api, fixture, lastMigration;
// A platform identity, because resolving one reads platform_grants on every
// request — the same shape as the column identity resolution touched during
// the real outage.
const PLATFORM_SUBJECT = 'readiness-platform';

const get = async path => {
  const response = await api(new Request('http://localhost' + path));
  return { status: response.status, ...await response.json() };
};
const authenticatedAs = async (subject, path) => {
  const jwt = await fixture.sign(subject);
  const response = await api(new Request('http://localhost' + path,
    { headers: { authorization: 'Bearer ' + jwt } }));
  return { status: response.status, ...await response.json() };
};

before(async () => {
  await migrate(db);
  fixture = await jwtFixture();
  api = createApi(db, { ...serverConfig(), ...fixture.config, demoLogin: false, commitSha: 'test-sha' }, fixture.resolver);
  lastMigration = (await declaredMigrations()).at(-1);
  await bootstrap(db, {
    operatorKey: 'readiness-op', operatorName: 'Readiness Operator', opsSubject: PLATFORM_SUBJECT,
    opsName: 'Readiness Platform', issuer: fixture.config.issuer, platformOps: true,
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('a current schema is ready, and says which build answered', async () => {
  const status = await schemaStatus(db);
  assert.equal(status.status, 'current');
  assert.equal(status.counts.pending, 0);

  const ready = await get('/api/v1/health/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.data.ready, true);
  assert.equal(ready.data.schema, 'current');
  assert.equal(ready.data.database, 'reachable');
  assert.equal(ready.data.migrations.applied, ready.data.migrations.declared);
  // A gate has to be able to tell the deployment it just shipped from the one
  // it replaced, or it asserts against whatever happens to be serving.
  assert.equal(ready.data.commit, 'test-sha');
});

test('readiness turns red on the exact condition /health cannot see', async () => {
  // Reproduce the outage: the ledger forgets the newest migration and the
  // table it created is gone, which is what "deployed ahead of the database"
  // actually looks like from inside the process.
  await db.transaction(async tx => {
    for (const table of lastMigration.tables) await tx.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    await tx.query('DELETE FROM schema_migrations WHERE name=$1', [lastMigration.name]);
  });

  const status = await schemaStatus(db);
  assert.equal(status.status, 'behind');
  assert.equal(status.counts.pending, 1);
  assert.deepEqual(status.pending, [lastMigration.name]);

  // Liveness is still green — this is the whole reason it was not enough.
  const live = await get('/api/v1/health');
  assert.equal(live.status, 200);
  assert.equal(live.data.status, 'ok');

  // Readiness is not, and fails with a status a monitor and a CI step both act on.
  const ready = await get('/api/v1/health/ready');
  assert.equal(ready.status, 503);
  assert.equal(ready.data.ready, false);
  assert.equal(ready.data.schema, 'behind');
  assert.equal(ready.data.migrations.pending, 1);

});

test('readiness never leaks migration names, SQL or connection detail', async () => {
  const ready = await get('/api/v1/health/ready');
  const body = JSON.stringify(ready);
  // Filenames describe unreleased work; they belong to Platform Ops holding
  // `system`, not to an unauthenticated endpoint a gate polls.
  assert.ok(!body.includes(lastMigration.name), 'migration filenames must not appear');
  assert.ok(!body.includes('.sql'));
  for (const leak of ['postgres', 'password', 'SELECT', 'schema_migrations', 'neon.tech']) {
    assert.ok(!body.includes(leak), `readiness must not expose ${leak}`);
  }
  assert.deepEqual(Object.keys(ready.data).sort(),
    ['commit', 'database', 'migrations', 'ready', 'schema', 'service']);
});

test('while the schema is behind, an authenticated request fails and /health still does not notice', async () => {
  // The precise 2026-09-22 shape. platform_grants is read during identity
  // resolution for every platform identity, so removing it is the same class
  // of fault as the missing users.last_authenticated_at column: not a feature
  // that breaks, but every authenticated request belonging to that identity.
  await db.transaction(tx => tx.query('DROP TABLE IF EXISTS platform_grants CASCADE'));
  await db.transaction(tx =>
    tx.query("DELETE FROM schema_migrations WHERE name LIKE '%platform_grants%'"));

  assert.equal((await get('/api/v1/health')).status, 200, 'liveness cannot see this, which is the point');

  const ready = await get('/api/v1/health/ready');
  assert.equal(ready.status, 503);
  assert.equal(ready.data.schema, 'behind');

  const me = await authenticatedAs(PLATFORM_SUBJECT, '/api/v1/me');
  assert.notEqual(me.status, 200,
    'a platform identity must fail while the table its resolution reads is absent');

  await migrate(db);
  assert.equal((await get('/api/v1/health/ready')).status, 200);
});

test('restoring the migration restores readiness', async () => {
  await migrate(db);
  const status = await schemaStatus(db);
  assert.equal(status.status, 'current');
  const ready = await get('/api/v1/health/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.data.ready, true);
});

test('checksum drift is reported as drift, not as current', async () => {
  await db.transaction(tx =>
    tx.query('UPDATE schema_migrations SET checksum=$2 WHERE name=$1', [lastMigration.name, 'not-the-real-checksum']));
  const status = await schemaStatus(db);
  assert.equal(status.status, 'drift');
  assert.deepEqual(status.drifted, [lastMigration.name]);

  const ready = await get('/api/v1/health/ready');
  assert.equal(ready.status, 503);
  assert.equal(ready.data.schema, 'drift');

  await db.transaction(tx =>
    tx.query('UPDATE schema_migrations SET checksum=$2 WHERE name=$1', [lastMigration.name, lastMigration.checksum]));
});

test('a database holding migrations this build does not declare reads as ahead', async () => {
  await db.transaction(tx =>
    tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', ['999_from_a_newer_build.sql', 'x']));
  const status = await schemaStatus(db);
  assert.equal(status.status, 'ahead');
  assert.deepEqual(status.unknown, ['999_from_a_newer_build.sql']);

  // Ahead is serviceable — migrations are additive, and a rollback should not
  // take the site down — but it is never silent.
  const ready = await get('/api/v1/health/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.data.schema, 'ahead');

  await db.transaction(tx => tx.query("DELETE FROM schema_migrations WHERE name='999_from_a_newer_build.sql'"));
});
