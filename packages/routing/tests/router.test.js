// The routing adapter, and the two promises it makes to a passenger.
//
//   1. NO STRAIGHT LINE, EVER. A route drawn between two cities is a claim
//      about roads. When there is no engine configured, no coordinates, no
//      road between the stops, or an engine having a bad minute, the answer is
//      an unavailable REASON — never a line that looks like a route and is not.
//   2. THE CREDENTIAL IS THE SERVER'S. A routing key is a server-side secret;
//      it travels in a header from here, and never reaches a browser.
//
// The engine is injected, so none of this reaches a provider. That matters beyond
// speed: a suite that needed a routing service online would be a suite that
// stops testing the refusals — which is most of what this file is about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, RoutingUnavailable, ROUTING_REASONS } from '../src/index.js';

const STOPS = [
  { longitude: 2.4183, latitude: 6.3654 },   // Cotonou
  { longitude: 2.6300, latitude: 9.3370 },   // Parakou
];

/** An OSRM-shaped answer with one leg per pair of stops. */
const osrmResponse = (overrides = {}) => ({
  code: 'Ok',
  routes: [{
    geometry: { coordinates: [[2.4183, 6.3654], [2.55, 7.9], [2.6300, 9.3370]] },
    distance: 360_000, duration: 22_200,
    legs: STOPS.slice(0, -1).map(() => ({ distance: 360_000, duration: 22_200 })),
    ...overrides,
  }],
});

/**
 * @param {any} payload the engine's answer
 * @param {{ status?: number, throws?: any, onCall?: (call: { url: string, init: any }) => void }} [options]
 */
const jsonFetch = (payload, { status = 200, throws = null, onCall } = {}) => async (url, init) => {
  onCall?.({ url, init });
  if (throws) throw throws;
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
};

const refusal = async promise => {
  try { await promise; } catch (error) {
    assert.ok(error instanceof RoutingUnavailable, `expected a RoutingUnavailable, got ${error?.name}`);
    return error.reason;
  }
  throw new Error('expected the router to refuse');
};

// ── no engine, no line ──────────────────────────────────────────────────────

test('with no engine configured, routing is unavailable rather than improvised', async () => {
  const router = createRouter({}, jsonFetch(osrmResponse()));
  assert.equal(router.configured, false);
  assert.equal(await refusal(router.route(STOPS)), ROUTING_REASONS.NOT_CONFIGURED);
});

test('a url that is not one leaves the router unconfigured', async () => {
  for (const url of ['', '  ', 'osrm.example.invalid', 'ftp://osrm.example.invalid']) {
    assert.equal(createRouter({ routing: { url } }).configured, false, url);
  }
});

test('stops without coordinates are refused, not guessed', async () => {
  const router = createRouter({ routing: { url: 'https://osrm.example.invalid' } }, jsonFetch(osrmResponse()));
  assert.equal(await refusal(router.route([{ longitude: 2.4, latitude: null }, STOPS[1]])),
    ROUTING_REASONS.MISSING_COORDINATES);
  assert.equal(await refusal(router.route([STOPS[0]])), ROUTING_REASONS.MISSING_COORDINATES);
  assert.equal(await refusal(router.route([STOPS[0], { longitude: 200, latitude: 6.3 }])),
    ROUTING_REASONS.MISSING_COORDINATES);
});

// ── what the engine says, and what is done about it ─────────────────────────

test('a road route comes back with its geometry, distance, duration and legs', async () => {
  /** @type {any} */ let called = null;
  const router = createRouter({ routing: { url: 'https://osrm.example.invalid/' } }, jsonFetch(osrmResponse(), { onCall: c => { called = c; } }));
  const result = await router.route(STOPS);
  assert.equal(result.coordinates.length, 3);
  assert.equal(result.distanceM, 360_000);
  assert.equal(result.durationS, 22_200);
  assert.equal(result.legs.length, 1);
  assert.equal(result.provider, 'osrm');
  // The engine is asked in its own terms: ordered lon,lat pairs through every
  // stop, full geometry, GeoJSON.
  assert.match(called.url, /^https:\/\/osrm\.example\.invalid\/route\/v1\/driving\/2\.4183,6\.3654;2\.63,9\.337\?/);
  assert.match(called.url, /overview=full/);
  assert.match(called.url, /geometries=geojson/);
});

test('the credential is a server-side header, never a public query parameter', async () => {
  /** @type {any} */ let called = null;
  const router = createRouter({ routing: { url: 'https://osrm.example.invalid', apiKey: 'ROUTING-SECRET' } },
    jsonFetch(osrmResponse(), { onCall: c => { called = c; } }));
  await router.route(STOPS);
  assert.equal(called.init.headers.authorization, 'Bearer ROUTING-SECRET');
  assert.doesNotMatch(called.url, /ROUTING-SECRET/, 'a key in the URL ends up in logs and referrers');
});

test('an engine that never answers is a timeout, and reads as one', async () => {
  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
  });
  const router = createRouter({ routing: { url: 'https://osrm.example.invalid', timeoutMs: 20 } }, hanging);
  assert.equal(await refusal(router.route(STOPS)), ROUTING_REASONS.PROVIDER_TIMEOUT);
});

test('a broken engine is a provider error, and a no-route answer is not', async () => {
  const failing = createRouter({ routing: { url: 'https://osrm.example.invalid' } }, jsonFetch({}, { status: 503 }));
  assert.equal(await refusal(failing.route(STOPS)), ROUTING_REASONS.PROVIDER_ERROR);
  const noRoad = createRouter({ routing: { url: 'https://osrm.example.invalid' } }, jsonFetch({ code: 'NoRoute' }));
  assert.equal(await refusal(noRoad.route(STOPS)), ROUTING_REASONS.NO_ROUTE);
});

test('geometry that cannot be a road is refused rather than drawn', async () => {
  for (const routes of [
    [{ geometry: { coordinates: [[2.4, 6.3]] }, distance: 1, duration: 1, legs: [] }],      // one point
    [{ geometry: { coordinates: null }, distance: 1, duration: 1, legs: [] }],
    [{ geometry: { coordinates: [[2.4, 6.3], [2.5, 7.4]] }, distance: 0, duration: 1, legs: [{}] }],
    [{ geometry: { coordinates: [[2.4, 6.3], [2.5, 7.4]] }, distance: 100, duration: 100, legs: [] }],
  ]) {
    const router = createRouter({ routing: { url: 'https://osrm.example.invalid' } }, jsonFetch({ code: 'Ok', routes }));
    const reason = await refusal(router.route(STOPS));
    assert.ok([ROUTING_REASONS.MALFORMED_GEOMETRY, ROUTING_REASONS.NO_ROUTE].includes(reason), reason);
  }
});

test('an unreadable answer is refused rather than half-read', async () => {
  const garbage = async () => new Response('<html>not json</html>', { status: 200 });
  const router = createRouter({ routing: { url: 'https://osrm.example.invalid' } }, garbage);
  assert.equal(await refusal(router.route(STOPS)), ROUTING_REASONS.MALFORMED_GEOMETRY);
});

test('the engine is named on the result, so a stored line says who made it', async () => {
  const router = createRouter({ routing: { url: 'https://valhalla.example.invalid', provider: 'valhalla' } }, jsonFetch(osrmResponse()));
  assert.equal((await router.route(STOPS)).provider, 'valhalla');
});
