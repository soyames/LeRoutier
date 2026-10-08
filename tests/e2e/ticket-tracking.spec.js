import { test, expect } from '@playwright/test';
import { mockApi, trackingFixture, ticketTrackingFixture, PUBLIC_REFERENCE } from './api-fixture.js';

// Following a journey by its ticket number, with no account anywhere.
//
// Somebody who bought without creating an account — which is the ordinary way
// to buy on LeRoutier — has to be able to see where the bus is, on the day,
// from a phone, without an identity of any kind. These tests hold that door
// open, and hold shut the things that must not come through it: the ticket
// number is eight hex characters a person reads off a ticket, so everything
// behind it has to be safe for a stranger to see.
//
// The states are the other half of it. A mistyped reference, a reference that
// names no ticket, a journey that has finished, a departure that was cancelled,
// a ticket whose vehicle has not reported yet — each is a different thing to
// say to somebody standing at a roadside, and none of them may be answered by
// inventing a position or an arrival time.
const APP = 'http://127.0.0.1:4173';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOOKING = id(40);
const PASSENGER = { id: id(99), display_name: 'Test Identity', role: 'passenger', operator_id: null, passenger_activated: true, needs_profile: false };

const signInAs = identity => async page => {
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session-passenger', user: identity } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: identity } }));
};

/**
 * Sign in, then reach /tracking the way a person does: through the app.
 *
 * A demonstration session lives in memory, so a `page.goto` would reload the
 * application and sign the account straight back out. The sign-in panel lives
 * on the tickets screen — /tracking is public and has none — and the journey to
 * it is the bar on a phone and the header on a wide screen, which is also the
 * navigation under test elsewhere.
 */
async function openTrackingSignedIn(page) {
  await page.goto(APP + '/tickets');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  const tab = page.getByRole('navigation', { name: 'Navigation voyageur' }).getByRole('link', { name: 'Trajets' });
  if (await tab.isVisible()) await tab.click();
  else await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name: 'Trajets' }).click();
  await expect(page).toHaveURL(APP + '/tracking');
}

/** Open /tracking as nobody at all, with the lookup endpoint overridden. */
async function openAsVisitor(page, handler) {
  await mockApi(page);
  if (handler) await page.route('**/api/v1/public/ticket-tracking/*', handler);
  await page.goto(APP + '/tracking');
}

const lookup = async (page, reference = PUBLIC_REFERENCE) => {
  await page.getByLabel('Référence du billet').fill(reference);
  await page.getByRole('button', { name: 'Afficher le suivi' }).click();
};

// ── the door is open ────────────────────────────────────────────────────────

test('a visitor follows a journey with a ticket number and is never asked to sign in', async ({ page }) => {
  await openAsVisitor(page);

  // The field is the point of the screen, and it is there from the first paint.
  await expect(page.getByLabel('Référence du billet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Afficher le suivi' })).toBeVisible();
  // Nothing here is a sign-in wall: this is one of the four public
  // destinations, and a menu entry that lands on a sign-in form has lied.
  await expect(page.getByText('Connexion requise')).toHaveCount(0);
  await expect(page.getByText('Bienvenue sur LeRoutier')).toHaveCount(0);

  await lookup(page);
  await expect(page.getByText('Cotonou → Parakou').first()).toBeVisible();
  await expect(page.getByText(PUBLIC_REFERENCE)).toBeVisible();
  // The same operational picture a signed-in passenger gets, in words.
  await expect(page.getByText('Suivi en direct').first()).toBeVisible();
  await expect(page.getByText(/Position mise à jour il y a 30 s/)).toBeVisible();
  await expect(page.getByText(/votre montée/)).toBeVisible();
  await expect(page.getByText(/votre descente/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Carte du véhicule sur son itinéraire' })).toBeVisible();
});

test('the public answer carries no passenger, contact, seat or payment detail', async ({ page }) => {
  await openAsVisitor(page);
  await lookup(page);
  await expect(page.getByText('Cotonou → Parakou').first()).toBeVisible();

  // Nothing a stranger with a guessed number must not learn. The fixture
  // deliberately carries none of it; this is what fails if one is ever added
  // to the projection and rendered.
  const body = await page.locator('body').innerText();
  for (const secret of ['passenger_id', '+229', 'Awa Sossou', 'seat_number', 'amount_minor', 'guestToken']) {
    expect(body, `${secret} must never reach a public tracking screen`).not.toContain(secret);
  }
  // And the small print says what the screen does and does not show.
  await expect(page.getByText(/Il ne montre ni votre identité, ni votre téléphone, ni votre paiement/)).toBeVisible();
});

test('the LRB- reference printed on a ticket names the same journey', async ({ page }) => {
  const asked = [];
  await openAsVisitor(page, r => { asked.push(r.request().url()); return r.fulfill({ json: { data: ticketTrackingFixture() } }); });
  await page.getByLabel('Référence du billet').fill(`LRB-${PUBLIC_REFERENCE.toLowerCase()}`);
  await page.getByRole('button', { name: 'Afficher le suivi' }).click();
  await expect(page.getByText('Cotonou → Parakou').first()).toBeVisible();
  // Sent with the prefix the printed ticket carries, folded to one case: a
  // reference read off a ticket and typed into a phone is not a
  // case-sensitive secret, and the reader should not have to match the
  // engraving. The API is what decides both — this is the client's half.
  expect(asked[0]).toContain(`LRB-${PUBLIC_REFERENCE}`);
});

// ── the answers that are not a journey ──────────────────────────────────────

test('a mistyped number is told apart from one that names no ticket', async ({ page }) => {
  await openAsVisitor(page, r => r.fulfill({ status: 400,
    json: { error: { code: 'INVALID_REFERENCE', message: 'Ce numéro de billet n’est pas valide.' } } }));
  await lookup(page, 'PAS-UN-NUMERO');
  await expect(page.getByRole('alert')).toContainText('La référence d’un billet compte 8 caractères');

  // A well-formed number with no ticket behind it says so instead of blaming
  // the typing.
  await mockApi(page);
  await page.route('**/api/v1/public/ticket-tracking/*', r => r.fulfill({ status: 404,
    json: { error: { code: 'NOT_FOUND', message: 'Aucun billet ne correspond à ce numéro.' } } }));
  await page.goto(APP + '/tracking');
  await lookup(page, 'DEADBEEF');
  await expect(page.getByRole('alert')).toContainText('Aucun billet ne correspond à ce numéro');
});

test('a spent allowance is reported as a limit, not as a missing ticket', async ({ page }) => {
  await openAsVisitor(page, r => r.fulfill({ status: 429,
    json: { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } } }));
  await lookup(page);
  await expect(page.getByRole('alert')).toContainText('Trop de recherches en peu de temps');
});

test('a finished journey says it is finished instead of showing a bus that has stopped', async ({ page }) => {
  await openAsVisitor(page, r => r.fulfill({ json: { data: ticketTrackingFixture({
    ticket: { ...ticketTrackingFixture().ticket, status: 'completed', serviceStatus: 'completed' } }) } }));
  await lookup(page);

  await expect(page.getByText('Voyage terminé')).toBeVisible();
  await expect(page.getByText(/Ce voyage est arrivé à son terme/)).toBeVisible();
  // The live panel is not drawn for a journey that is over: a progress bar on
  // a finished trip reads as one still running.
  await expect(page.getByRole('region', { name: 'Carte du véhicule sur son itinéraire' })).toHaveCount(0);
});

test('a cancelled departure is stated plainly and promised no tracking', async ({ page }) => {
  await openAsVisitor(page, r => r.fulfill({ json: { data: ticketTrackingFixture({
    ticket: { ...ticketTrackingFixture().ticket, serviceStatus: 'cancelled' }, tracking: null }) } }));
  await lookup(page);

  await expect(page.getByText('Service annulé')).toBeVisible();
  await expect(page.getByText(/Ce départ a été annulé/)).toBeVisible();
  await expect(page.getByText(/Où est le véhicule/)).toHaveCount(0);
});

test('a ticket whose vehicle has not reported yet says so, and invents nothing', async ({ page }) => {
  await openAsVisitor(page, r => r.fulfill({ json: { data: ticketTrackingFixture({
    tracking: trackingFixture({ position: null, signal: 'unavailable', signalAgeSeconds: null,
      progress: null, nextStop: null, eta: { at: null, confidence: 'unavailable', speedMps: null, roundedToMinutes: 5 } }) }) } }));
  await lookup(page);

  await expect(page.getByText('Suivi indisponible').first()).toBeVisible();
  await expect(page.getByText(/n’a pas encore partagé sa position/)).toBeVisible();
  await expect(page.getByText(/Heure d’arrivée indisponible/)).toBeVisible();
  await expect(page.getByText(/Distance restante/)).toHaveCount(0);
});

// ── a journey the app already knows about ───────────────────────────────────

test('a signed-in passenger sees their current and upcoming journeys without typing anything', async ({ page }) => {
  await mockApi(page);
  await signInAs(PASSENGER)(page);
  // Two journeys of their own: one boarded, one still to come.
  await page.route('**/api/v1/me/bookings', r => r.fulfill({ json: { data: [
    { id: BOOKING, status: 'boarded', departure_city: 'Cotonou', arrival_city: 'Parakou',
      route_name: 'DEMO Cotonou → Parakou', departure_at: '2026-09-16T07:30:00.000Z', seat_number: 4,
      amount_minor: 7500, currency: 'XOF' },
    { id: id(41), status: 'confirmed', departure_city: 'Parakou', arrival_city: 'Cotonou',
      route_name: 'DEMO Cotonou → Parakou', departure_at: '2026-09-20T07:30:00.000Z', seat_number: 7,
      amount_minor: 7500, currency: 'XOF' },
  ] } }));
  await openTrackingSignedIn(page);

  // Both are shown, and the journey under way is tracked without a keystroke.
  await expect(page.getByText('Cotonou → Parakou').first()).toBeVisible();
  await expect(page.getByText('Parakou → Cotonou').first()).toBeVisible();
  await expect(page.getByText('Suivi en direct').first()).toBeVisible();
  // And the ticket-number door is still open on the same page, for somebody
  // else's ticket or for a purchase made on another device.
  await expect(page.getByLabel('Référence du billet')).toBeVisible();
});

test('a passenger with no journey at all is offered a search, not a sign-in', async ({ page }) => {
  await mockApi(page);
  await signInAs(PASSENGER)(page);
  await openTrackingSignedIn(page);

  await expect(page.getByText('Aucun trajet en cours')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rechercher un trajet' })).toBeVisible();
  await expect(page.getByLabel('Référence du billet')).toBeVisible();
});
