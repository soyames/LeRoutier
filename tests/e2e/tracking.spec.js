import { test, expect } from '@playwright/test';
import { mockApi, trackingFixture } from './api-fixture.js';

// Maps, road routing, GPS and arrival estimates — tested against the promises
// the product makes rather than against the implementation:
//
//   - "Suivi en direct" appears only while real, recent GPS is arriving.
//   - A straight line between two cities is never drawn as a road.
//   - An arrival time states how much it can be trusted.
//   - Only assigned crew publish positions, and only when they turn it on.
//
// No test reaches a tile server or a routing engine: the fixture blocks tiles
// and serves geometry, so the suite is deterministic offline.
const APP = 'http://127.0.0.1:4176';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOOKING = id(40);
const IDENTITY = id(99);
const me = extra => ({ id: IDENTITY, display_name: 'Test Identity', needs_profile: false, ...extra });
const PASSENGER = me({ role: 'passenger', operator_id: null });
const COMPANY_DRIVER = me({ role: 'driver', operator_type: 'company', operator_id: id(1), verification_status: 'verified' });
const OPS = me({ role: 'ops', operator_type: 'company', operator_id: id(1), verification_status: 'verified' });

const signInAs = identity => async page => {
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: identity } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: identity } }));
};

/** Open a route as an identity, overriding the journey tracking payload. */
async function openTracking(page, tracking, { identity = PASSENGER, route = `/tickets/${BOOKING}` } = {}) {
  await mockApi(page);
  await signInAs(identity)(page);
  // Registered after mockApi, so this handler wins.
  if (tracking) await page.route('**/api/v1/journeys/*/tracking', r => r.fulfill({ json: { data: tracking } }));
  await page.goto(APP + route);
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
}

// ------------------------------------------------------- passenger tracking --
test('live GPS shows the vehicle on the real road with progress and next stop', async ({ page }) => {
  await openTracking(page, trackingFixture());

  await expect(page.getByText('Suivi en direct').first()).toBeVisible();
  await expect(page.getByText(/Position mise à jour il y a 30 s/)).toBeVisible();

  // The map is real Leaflet over real geometry, not a picture of a map.
  const map = page.getByRole('region', { name: 'Carte du véhicule sur son itinéraire' });
  await expect(map).toBeVisible();
  await expect(map.locator('.leaflet-container')).toBeVisible();
  // One drawn line per side of the vehicle: road behind, road ahead.
  await expect(map.locator('path.leaflet-interactive')).toHaveCount(2 + 4, { timeout: 15_000 });

  // Everything on the map is also stated in words.
  await expect(page.getByText('Prochain arrêt').first()).toBeVisible();
  await expect(page.getByText('Dassa-Zoumè', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('130 km')).toBeVisible();
  await expect(page.getByText('230 km')).toBeVisible();
  await expect(page.getByText(/Arrivée estimée vers/)).toBeVisible();
});

test('maps use the configured OpenStreetMap basemap without Google Maps', async ({ page }) => {
  // The pilot basemap is OpenStreetMap. Geometry remains useful even if tile
  // requests are blocked, so this test never depends on a tile server.
  const tileRequests = [];
  page.on('request', request => {
    if (request.url().includes('tile.openstreetmap.org')) tileRequests.push(request.url());
  });
  await openTracking(page, trackingFixture());
  const map = page.getByRole('region', { name: 'Carte du véhicule sur son itinéraire' });
  await expect(map.locator('.leaflet-container')).toBeVisible();
  // The road geometry is still drawn, so tracking works without a provider.
  await expect(map.locator('path.leaflet-interactive').first()).toBeVisible();
  await expect.poll(() => tileRequests.length).toBeGreaterThan(0);
  await expect(page.locator('body')).not.toContainText('Google Maps');
});

test('a stale fix is never presented as live, and the ETA says it came from the timetable', async ({ page }) => {
  await openTracking(page, trackingFixture({
    signal: 'stale', signalAgeSeconds: 1500,
    eta: { at: '2026-09-16T13:40:00Z', confidence: 'scheduled', speedMps: null, roundedToMinutes: 5 },
  }));

  await expect(page.getByText('Dernière position connue').first()).toBeVisible();
  await expect(page.getByText('Suivi en direct')).toHaveCount(0);
  await expect(page.getByText(/Arrivée prévue à l’horaire/)).toBeVisible();
  await expect(page.getByText(/vient de l’horaire de l’opérateur, pas de la position/)).toBeVisible();
});

test('a delayed signal is named as delayed rather than hidden', async ({ page }) => {
  await openTracking(page, trackingFixture({ signal: 'delayed', signalAgeSeconds: 240 }));
  await expect(page.getByText('Signal GPS retardé').first()).toBeVisible();
  await expect(page.getByText(/Position mise à jour il y a 4 min/)).toBeVisible();
});

test('without road geometry the stops stay exact and no line is drawn', async ({ page }) => {
  await openTracking(page, trackingFixture({
    route: { available: false, coordinates: null, distanceM: null, provider: null, generatedAt: null },
    progress: null,
    eta: { at: '2026-09-16T13:40:00Z', confidence: 'scheduled', speedMps: null, roundedToMinutes: 5 },
  }));

  await expect(page.getByText(/itinéraire routier de cette ligne n’est pas encore disponible/)).toBeVisible();
  // No map at all is correct; a straight Cotonou→Parakou line would not be.
  await expect(page.getByRole('region', { name: 'Carte du véhicule sur son itinéraire' })).toHaveCount(0);
  // The operational picture survives without geometry.
  await expect(page.getByText('Progression du trajet')).toBeVisible();
  await expect(page.getByText('Dassa-Zoumè', { exact: true }).first()).toBeVisible();
});

test('before the vehicle reports, nothing is invented', async ({ page }) => {
  await openTracking(page, trackingFixture({
    position: null, signal: 'unavailable', signalAgeSeconds: null, progress: null, nextStop: null,
    eta: { at: null, confidence: 'unavailable', speedMps: null, roundedToMinutes: 5 },
  }));

  await expect(page.getByText('Suivi indisponible').first()).toBeVisible();
  await expect(page.getByText(/n’a pas encore partagé sa position/)).toBeVisible();
  await expect(page.getByText(/Heure d’arrivée indisponible/)).toBeVisible();
  await expect(page.getByText(/Distance restante/)).toHaveCount(0);
});

test('the passenger sees which stop is theirs', async ({ page }) => {
  await openTracking(page, trackingFixture());
  await expect(page.getByText(/votre montée/)).toBeVisible();
  await expect(page.getByText(/votre descente/)).toBeVisible();
});

// ------------------------------------------------------------- crew capture --
test('vehicle tracking is off until the crew turn it on', async ({ page }) => {
  await mockApi(page);
  await signInAs(COMPANY_DRIVER)(page);
  await page.goto(APP + '/work/today');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();

  await expect(page.getByText('Suivi du véhicule', { exact: true })).toBeVisible();
  await expect(page.getByText('Suivi désactivé')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activer le suivi du véhicule' })).toBeVisible();
});

test('crew sees the authorized service progress and next-stop ETA', async ({ page }) => {
  await mockApi(page);
  await signInAs(COMPANY_DRIVER)(page);
  await page.goto(APP + '/work/today');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();

  await expect(page.getByText('Progression du service')).toBeVisible();
  await expect(page.getByText('Prochain arrêt').last()).toBeVisible();
  await expect(page.getByText(/Dassa-Zoumè · 11:00/)).toBeVisible();
  await expect(page.getByText(/Arrivée prévue/)).toBeVisible();
});

test.describe('with location granted', () => {
  test.use({ permissions: ['geolocation'], geolocation: { latitude: 7.3925, longitude: 2.1004 } });

  test('enabling capture publishes the vehicle position and states the web limit', async ({ page }) => {
    const published = [];
    await mockApi(page);
    await signInAs(COMPANY_DRIVER)(page);
    await page.route('**/api/v1/services/*/positions', r => {
      published.push(r.request().postDataJSON());
      return r.fulfill({ json: { data: { accepted: true } } });
    });
    await page.goto(APP + '/work/today');
    await page.getByRole('button', { name: 'Connexion de développement' }).click();
    await page.getByRole('button', { name: 'Activer le suivi du véhicule' }).click();

    await expect(page.getByText('Suivi actif')).toBeVisible();
    // The honest statement of what a web app cannot do stays on screen.
    await expect(page.getByText(/s’interrompt si cette page est fermée ou mise en arrière-plan/)).toBeVisible();

    await expect.poll(() => published.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const fix = published[0];
    expect(fix.source).toBe('pwa_device');
    expect(fix.latitude).toBeCloseTo(7.3925, 3);
    expect(fix.longitude).toBeCloseTo(2.1004, 3);
    expect(typeof fix.observedAt).toBe('string');
  });
});

test('a refused permission is reported as refused, not as tracking', async ({ page, context }) => {
  await context.clearPermissions();
  await mockApi(page);
  await signInAs(COMPANY_DRIVER)(page);
  await page.goto(APP + '/work/today');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  await page.getByRole('button', { name: 'Activer le suivi du véhicule' }).click();

  await expect(page.getByText('Localisation refusée')).toBeVisible();
  await expect(page.getByText('Suivi actif')).toHaveCount(0);
});

// --------------------------------------------------------------- ops fleet --
test('ops sees its own fleet with progress, next stop and confirmed deviation', async ({ page }) => {
  await mockApi(page);
  await signInAs(OPS)(page);
  await page.route('**/api/v1/ops/fleet-tracking', r => r.fulfill({ json: { data: [
    trackingFixture({ offRoute: true, offRouteM: 820 }),
  ] } }));
  await page.goto(APP + '/ops/services');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();

  await expect(page.getByText('Cotonou → Parakou', { exact: true })).toBeVisible();
  await expect(page.getByText(/prochain arrêt Dassa-Zoumè/)).toBeVisible();
  await expect(page.getByText('36 % · 230 km restants')).toBeVisible();
  // Deviation is an operational signal — surfaced here, never to passengers.
  await expect(page.getByText('Hors itinéraire')).toBeVisible();
});

test('ops fleet tracking states plainly when nothing is running', async ({ page }) => {
  await mockApi(page);
  await signInAs(OPS)(page);
  await page.route('**/api/v1/ops/fleet-tracking', r => r.fulfill({ json: { data: [] } }));
  await page.goto(APP + '/ops/services');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();

  await expect(page.getByText('Aucun service en circulation')).toBeVisible();
});

test('ops is told when a route has no generated geometry', async ({ page }) => {
  await mockApi(page);
  await signInAs(OPS)(page);
  await page.route('**/api/v1/ops/fleet-tracking', r => r.fulfill({ json: { data: [
    trackingFixture({ route: { available: false, coordinates: null, distanceM: null, provider: null, generatedAt: null }, progress: null }),
  ] } }));
  await page.goto(APP + '/ops/services');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();

  await expect(page.getByText('Itinéraire routier')).toBeVisible();
  await expect(page.getByText('non généré')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Voir sur la carte' })).toHaveCount(0);
});
