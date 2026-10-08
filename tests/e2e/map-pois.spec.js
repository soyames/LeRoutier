import { test, expect } from '@playwright/test';
import { mockApi, trackingFixture } from './api-fixture.js';

// What the journey map draws besides the journey.
//
// A route line answers "where is the bus". It does not answer "where do I get
// on", which is the question somebody at a roadside actually has — so the map
// carries LeRoutier's own published places on top of it: verified boarding
// points, stations and stops.
//
// Four properties these tests exist to hold:
//
//   1. They are CONTEXT. Drawn in a pane below the route and the journey's own
//      stops, so a boarding point can never sit on top of the stop being looked
//      for.
//   2. They have a DENSITY GATE. At the scale the journey map opens on —
//      framed on a two-hundred-kilometre route — they are not drawn and not
//      even asked for, because a country covered in dots is a country whose
//      roads you cannot read. Zooming to a city is what turns them on.
//   3. They are a CHOICE. A real control with a pressed state, not a setting
//      somebody has to find elsewhere.
//   4. The map says WHAT IT IS DRAWN ON. The tile provider is named on the
//      element and credited in Leaflet's own control, because a map drawn from
//      a service this product is not entitled to is a map that must not ship.
const APP = 'http://127.0.0.1:4173';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOOKING = id(40);
const PASSENGER = { id: id(99), display_name: 'Test Identity', role: 'passenger', operator_id: null, passenger_activated: true, needs_profile: false };

/** Open the journey map as a signed-in passenger, optionally watching the reads. */
async function openTracking(page, tracking, watchPoints) {
  await mockApi(page);
  if (watchPoints) await page.route('**/api/v1/map/points*', route => { watchPoints(route.request().url()); return route.fallback(); });
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: PASSENGER } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: PASSENGER } }));
  if (tracking) await page.route('**/api/v1/journeys/*/tracking', r => r.fulfill({ json: { data: tracking } }));
  await page.goto(APP + `/tickets/${BOOKING}`);
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  await expect(page.locator('.leaflet-container')).toBeVisible();
}

/**
 * The journey map opens framed on the WHOLE ROUTE — Cotonou to Parakou is two
 * hundred kilometres — so it starts at country zoom, below the gate. Zooming in
 * is how a reader reaches the scale where a boarding point means something, and
 * it is what these tests do rather than what they assume.
 */
async function zoomIn(page, steps = 4) {
  for (let i = 0; i < steps; i++) {
    await page.locator('.leaflet-control-zoom-in').click();
    await page.waitForTimeout(150);
  }
}

test('at the scale the journey map opens on, no points are asked for and the map says why', async ({ page }) => {
  const asked = [];
  await openTracking(page, trackingFixture(), url => asked.push(url));
  await page.waitForTimeout(900);

  // Country zoom: dots would be a texture, not information.
  await expect(page.getByText(/zoomez pour afficher les points d’embarquement/)).toBeAttached();
  // And nothing was even asked for — a request the screen cannot use is a
  // request the registry should not have to answer.
  expect(asked, 'no viewport-wide request for a country-sized view').toEqual([]);
});

test('zoomed to a city, the points are drawn under the route and its stops', async ({ page }) => {
  const asked = [];
  await openTracking(page, trackingFixture(), url => asked.push(url));
  await zoomIn(page);

  // The request follows the viewport, and names it.
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(asked[0]).toMatch(/bbox=-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+/);
  await expect(page.getByText(/point(s)? utile(s)? affiché(s)? sur la carte/)).toBeAttached();

  // They are drawn in a pane below the one the route and its stops are in, so
  // a boarding point can never cover the stop somebody is looking for. Leaflet
  // names a custom pane after itself: `lrPois` becomes `leaflet-lrPois-pane`.
  const zIndexes = await page.evaluate(() => {
    const panes = [...document.querySelectorAll('.leaflet-pane')];
    const named = name => panes.find(p => p.classList.contains(name));
    return { pois: named('leaflet-lrPois-pane') ? getComputedStyle(named('leaflet-lrPois-pane')).zIndex : null,
      overlay: named('leaflet-overlay-pane') ? getComputedStyle(named('leaflet-overlay-pane')).zIndex : null };
  });
  expect(zIndexes.pois, 'the points layer has its own pane').not.toBeNull();
  expect(Number(zIndexes.pois), 'and sits below the route').toBeLessThan(Number(zIndexes.overlay));
});

test('the layer is a control with a state, and turning it off draws nothing', async ({ page }) => {
  await openTracking(page, trackingFixture());
  await zoomIn(page);
  const toggle = page.getByRole('button', { name: /les points utiles/ });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/point(s)? utile(s)? affiché(s)? sur la carte/)).toBeAttached();

  await toggle.click();
  // Turning it off is stated in words, not only by the markers disappearing —
  // on a canvas of tiles, "the dots are gone" is not something everybody sees.
  await expect(page.getByRole('button', { name: 'Afficher les points utiles' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('Points utiles masqués.')).toBeAttached();
  await expect(page.locator('.leaflet-pane.leaflet-lrPois-pane path')).toHaveCount(0);

  await page.getByRole('button', { name: 'Afficher les points utiles' }).click();
  await expect(page.getByRole('button', { name: 'Masquer les points utiles' })).toHaveAttribute('aria-pressed', 'true');
});

test('the map names what it is drawn on, and credits it', async ({ page }) => {
  await openTracking(page, trackingFixture());
  // Which basemap is in use is not something to discover from a support
  // ticket: the element carries it, and the pilot fallback has a name.
  await expect(page.locator('.lr-map')).toHaveAttribute('data-tile-provider', 'osm-public');
  // Leaflet's own attribution control carries the credit the tiles require.
  const credit = page.locator('.leaflet-control-attribution');
  await expect(credit).toContainText('OpenStreetMap');
  await expect(credit.getByRole('link', { name: 'OpenStreetMap' })).toHaveAttribute('href', /openstreetmap\.org\/copyright/);
});
