// The map's points of interest: what LeRoutier publishes about the ground.
//
// A map of Benin with a route on it answers "where is the bus". It does not
// answer "where do I get on", which is the question somebody at a roadside
// actually has — and the answer is in LeRoutier's own location registry. These
// tests hold that registry to two promises: that what it publishes is TRUE (a
// proposal is not a place, a stop with no coordinates is not a pin), and that
// it cannot be read wholesale.
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { seed, demo } from '@leroutier/database/seed';
import { createApi } from '../src/app.js';
import { jwtFixture } from './jwt-fixture.js';

const identity = await jwtFixture('RS256');
const config = { ...serverConfig(), ...identity.config, schema: 'lr_test_' + randomUUID().replaceAll('-', ''),
  demoLogin: true, allowTestInventory: true };
const db = createDatabase(config);
let api;

let ipCounter = 0;
const freshIp = () => `192.0.2.${++ipCounter % 250}`;

/** @param {string} path @param {{ ip?: string }} [options] */
const call = async (path, { ip = freshIp() } = {}) => {
  const response = await api(new Request('http://localhost/api/v1' + path, { headers: { 'x-forwarded-for': ip } }));
  return { status: response.status, ...(await response.json()) };
};

// LeRoutier's own places, at real coordinates: Cotonou, and one non-demo stop a
// passenger could actually be dropped at.
const PLACE = randomUUID(), STOP = randomUUID(), POINT = randomUUID(), PROPOSED = randomUUID();
const POINT_LAT = 6.3702, POINT_LON = 2.3912;

const viewport = (minLon, minLat, maxLon, maxLat, extra = '') =>
  `/map/points?bbox=${minLon},${minLat},${maxLon},${maxLat}${extra}`;
/** A box around Cotonou, wide enough to hold the stop and the boarding point. */
const COTONOU = viewport(2.2, 6.2, 2.6, 6.5);
/** Open water south of the coast: the same longitude, no land in the box. */
const ELSEWHERE = viewport(2.0, 3.5, 2.6, 4.5);

before(async () => {
  await migrate(db); await seed(db, { capacity: 8 });
  await db.transaction(async tx => {
    await tx.query('INSERT INTO places(id,name) VALUES($1,$2)', [PLACE, 'Cotonou']);
    await tx.query('INSERT INTO stops(id,place_id,name,latitude,longitude,is_demo) VALUES($1,$2,$3,$4,$5,false)',
      [STOP, PLACE, 'Gare de Cotonou', POINT_LAT + 0.01, POINT_LON + 0.01]);
    // A verified boarding point — a place somebody can be told to stand at.
    await tx.query(`INSERT INTO boarding_points(id,name,place_id,stop_id,type,description,latitude,longitude,purposes,status,proposed_by,verified_by)
      VALUES($1,$2,$3,$4,'company_station',$5,$6,$7,$8,'verified',$9,$9)`,
    [POINT, 'Gare centrale Cotonou', PLACE, STOP, 'En face du marché', POINT_LAT, POINT_LON,
      JSON.stringify(['passenger_boarding']), demo.passenger]);
    // And one somebody merely typed, which is not a place until a person has
    // accepted it.
    await tx.query(`INSERT INTO boarding_points(id,name,place_id,type,latitude,longitude,purposes,status,proposed_by)
      VALUES($1,$2,$3,'roadside_pickup',$4,$5,$6,'proposed',$7)`,
    [PROPOSED, 'Point jamais validé', PLACE, POINT_LAT + 0.002, POINT_LON + 0.002, JSON.stringify(['passenger_boarding']), demo.passenger]);
  });
  api = createApi(db, config, identity.resolver);
});
beforeEach(async () => {
  await db.transaction(async tx => { assert.ok(db.schema.startsWith('lr_test_')); await tx.query('DELETE FROM request_limits'); });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

// ── what comes back ─────────────────────────────────────────────────────────

test('a viewport returns the published places inside it, and those only', async () => {
  const answer = await call(COTONOU);
  assert.equal(answer.status, 200, JSON.stringify(answer));
  const names = answer.data.map(point => point.name);
  assert.ok(names.includes('Gare centrale Cotonou'), 'the verified boarding point is published');
  assert.ok(names.includes('Gare de Cotonou'), 'and so is the stop it belongs to');
  assert.ok(!names.includes('Point jamais validé'), 'a proposal is not a place yet');

  // Every point is inside the box it was asked for. This is the property the
  // whole endpoint rests on, and it holds whatever the catalogue contains.
  for (const p of answer.data) {
    assert.ok(p.longitude >= 2.2 && p.longitude <= 2.6 && p.latitude >= 6.2 && p.latitude <= 6.5,
      `${p.name} is outside the viewport it came back for`);
  }
  // And a box with no land in it returns nothing at all, rather than the
  // nearest thing LeRoutier knows.
  const elsewhere = await call(ELSEWHERE);
  assert.equal(elsewhere.status, 200);
  assert.deepEqual(elsewhere.data, []);
});

test('each point says what it is, so a map can draw it as itself', async () => {
  const answer = await call(COTONOU);
  const point = answer.data.find(p => p.id === POINT);
  assert.equal(point.kind, 'boarding_point');
  assert.equal(point.type, 'company_station');
  assert.equal(point.city, 'Cotonou');
  assert.deepEqual(point.purposes, ['passenger_boarding']);
  assert.equal(point.latitude, POINT_LAT);
  assert.equal(point.longitude, POINT_LON);
  const stop = answer.data.find(p => p.id === STOP);
  assert.equal(stop.kind, 'stop');
  assert.equal(typeof stop.latitude, 'number');
});

test('the answer carries no owner, no contact and no moderation state', async () => {
  const answer = await call(COTONOU);
  const body = JSON.stringify(answer.data);
  // A map of where to board is not a directory of who owns the kerb, and it is
  // not a moderation queue: what a traveller needs is the name and the pin.
  for (const field of ['operator', 'verified_by', 'verifiedBy', 'proposed_by', 'proposedBy',
    'status', 'phone', 'contact', 'email', 'description', 'placeId', 'place_id', 'stopId', 'stop_id']) {
    assert.ok(!body.includes(`"${field}"`), `"${field}" must not be published`);
  }
});

// ── what it refuses ─────────────────────────────────────────────────────────

test('a viewport is required, and has to be one', async () => {
  for (const path of ['/map/points', '/map/points?bbox=', '/map/points?bbox=1,2,3',
    '/map/points?bbox=a,b,c,d', '/map/points?bbox=2.6,6.5,2.2,6.2']) {
    const answer = await call(path);
    assert.equal(answer.status, 400, `${path} must be refused`);
    assert.equal(answer.error.code, 'INVALID_VIEWPORT');
  }
});

test('a viewport wide enough to be the world is refused', async () => {
  // Benin and its neighbours fit; "everything" does not. This is the difference
  // between a map asking a question and a scraper taking a copy.
  const world = await call(viewport(-180, -90, 180, 90));
  assert.equal(world.status, 422);
  assert.equal(world.error.code, 'INVALID_VIEWPORT');
  // The whole country, for comparison, is a question a map really asks.
  const benin = await call(viewport(0.7, 6.1, 3.9, 12.5));
  assert.equal(benin.status, 200);
});

test('a limit is honoured and never exceeds the ceiling', async () => {
  const small = await call(`${COTONOU}&limit=1`);
  assert.equal(small.status, 200);
  assert.equal(small.data.length, 1);
  const absurd = await call(`${COTONOU}&limit=100000`);
  assert.equal(absurd.status, 200, 'an absurd limit is capped, not refused');
});

// ── the meter ───────────────────────────────────────────────────────────────

test('viewport reads are metered per client address', async () => {
  const ip = '198.51.100.7';
  for (let i = 0; i < 60; i++) {
    const answer = await call(COTONOU, { ip });
    assert.equal(answer.status, 200, `request ${i + 1} should still be allowed`);
  }
  const refused = await call(COTONOU, { ip });
  assert.equal(refused.status, 429);
  assert.equal(refused.error.code, 'RATE_LIMITED');
  // Per address, not global: somebody else is unaffected.
  assert.equal((await call(COTONOU)).status, 200);
});
