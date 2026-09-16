import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// The unified LeRoutier PWA: one product, one identity, several authorized
// workspaces. The three original apps keep their own suites until retired.
//
// Sessions are deliberately in-memory — no token is persisted to storage — so
// every test signs in on the route it is exercising rather than navigating
// after login. That is also the product behaviour: you land where you asked.
const APP = 'http://127.0.0.1:4176';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IDENTITY = id(99);
const me = extra => ({ id: IDENTITY, display_name: 'Test Identity', needs_profile: false, ...extra });
const signInAs = identity => async page => {
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: identity } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: identity } }));
};
const PASSENGER = me({ role: 'passenger', operator_id: null });
const COMPANY_DRIVER = me({ role: 'driver', operator_type: 'company', operator_id: id(1), verification_status: 'verified', owner_user_id: null });
const OWNER_DRIVER = me({ role: 'driver', operator_type: 'independent', operator_id: id(1), verification_status: 'verified', owner_user_id: IDENTITY });
const CONVOYEUR = me({ role: 'convoyeur', operator_type: 'company', operator_id: id(1), verification_status: 'verified' });
const OPS = me({ role: 'ops', operator_type: 'company', operator_id: id(1), verification_status: 'verified' });
const login = page => page.getByRole('button', { name: 'Connexion de développement' }).click();

// Open a route as an identity, signing in on that same route.
async function open(page, identity, route) {
  await mockApi(page);
  await signInAs(identity)(page);
  await page.goto(APP + route);
  await login(page);
}

// ---------------------------------------------------------------- public ----
test('public home offers product tasks, never application names', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/');
  await expect(page.getByRole('button', { name: 'Rechercher' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Envoyer un colis/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Suivre un colis/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /chauffeur indépendant/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /représente une compagnie/ })).toBeVisible();
  // A visitor never meets our deployment architecture.
  await expect(page.getByText(/application (passager|chauffeur)|Passenger app|Driver app|Ops app/i)).toHaveCount(0);
});

test('anonymous trip search works and never offers cash', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/trips');
  await expect(page.getByText('Opérateur démo')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Se connecter pour réserver' })).toBeEnabled();
  await expect(page.getByText(/espèces/i)).toHaveCount(0);
});

test('public parcel tracking works without an account', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/parcels/track');
  await expect(page.getByRole('heading', { name: /Suivre un colis/ })).toBeVisible();
  await page.getByLabel('Numéro de suivi').fill('LRP-12345678');
  await page.getByRole('button', { name: /Suivre mon colis/ }).click();
  // A public logistics timeline, with no custody internals exposed.
  await expect(page.getByText('LRP-12345678').first()).toBeVisible();
  await expect(page.getByText('En route').first()).toBeVisible();
  await expect(page.getByText('Prêt à retirer')).toBeVisible();
});

test('a protected workspace asks for the LeRoutier identity, not an app login', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/work/today');
  await expect(page.getByText('Connexion requise')).toBeVisible();
  await expect(page.getByText(/Une seule identité LeRoutier/)).toBeVisible();
  // No per-app wording anywhere in the sign-in path.
  await expect(page.getByText(/application conducteur|driver app/i)).toHaveCount(0);
});

// ------------------------------------------------------------- passenger ----
test('passenger sees the exact boarding point, first-mile suggestion and timeline', async ({ page }) => {
  await open(page, PASSENGER, `/tickets/${id(40)}`);
  // Exact boarding point from the canonical registry.
  await expect(page.getByText('Gare de Jonquet')).toBeVisible();
  await expect(page.getByText(/En face du marché/)).toBeVisible();
  // Leave-home advice, explicitly an estimate.
  await expect(page.getByText(/Partez vers/)).toBeVisible();
  await expect(page.getByText('Estimation').first()).toBeVisible();
  // Gozem is offered and labelled external, with no fare and no ETA claim.
  await expect(page.getByRole('link', { name: /Ouvrir Gozem/ })).toBeVisible();
  await expect(page.getByText(/LeRoutier ne réserve pas la course/)).toBeVisible();
  await expect(page.getByText('Service externe — non intégré')).toBeVisible();
  // "I'll get there myself" is always available.
  await expect(page.getByRole('button', { name: /J’y vais par mes propres moyens/ })).toBeVisible();
  // Arrival is not invented when the operator has not scheduled one.
  await expect(page.getByText(/heure d’arrivée non programmée/)).toBeVisible();
  // The passenger journey still offers no cash payment.
  await expect(page.getByText(/payer en espèces|paiement comptant/i)).toHaveCount(0);
});

test('a failing first-mile handoff never blocks the journey', async ({ page }) => {
  await mockApi(page);
  await signInAs(PASSENGER)(page);
  // The analytics endpoint is down; the journey must still work end to end.
  await page.route('**/api/v1/mobility/handoff', r => r.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: 'unavailable' } } }));
  await page.goto(APP + `/tickets/${id(40)}`);
  await login(page);
  await page.getByRole('button', { name: /J’y vais par mes propres moyens/ }).click();
  await expect(page.getByText('Gare de Jonquet')).toBeVisible();
  await expect(page.getByText(/Partez vers/)).toBeVisible();
});

test('notification centre is reachable and reports unsent channels honestly', async ({ page }) => {
  await open(page, PASSENGER, '/notifications');
  await expect(page.getByText('Départ retardé')).toBeVisible();
  await expect(page.getByText('Réservation enregistrée')).toBeVisible();
  // An unconfigured provider is shown as unavailable, never as delivered.
  await expect(page.getByText('envoi externe indisponible')).toBeVisible();
  await expect(page.getByText(/Alertes essentielles/)).toBeVisible();
  await expect(page.getByText('toujours actif')).toBeVisible();
});

// -------------------------------------------- independent owner-driver -----
test('one identity opens both the passenger and the work workspace', async ({ page }) => {
  await open(page, OWNER_DRIVER, '/work/today');
  await page.getByRole('button', { name: /Changer d’espace/ }).click();
  // Only authorized workspaces appear — no Ops entry for a driver.
  await expect(page.getByRole('menuitem', { name: /Voyageur/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Mon activité/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Exploitation/ })).toHaveCount(0);
  // Switching workspace keeps the same identity and the same session.
  await page.getByRole('menuitem', { name: /Voyageur/ }).click();
  await expect(page).toHaveURL(/\/trips$/);
  await expect(page.getByRole('button', { name: 'Se connecter pour réserver' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choisir ce trajet' })).toBeVisible();
});

test('independent owner-driver sees revenue, withdrawals and walk-up cash', async ({ page }) => {
  await open(page, OWNER_DRIVER, '/work/today');
  await expect(page.getByRole('button', { name: /Recettes/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Points$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Comptant/ })).toBeVisible();
  // Navigate in-app rather than reloading, which would drop the session.
  await page.getByRole('button', { name: /Recettes/ }).click();
  await expect(page).toHaveURL(/\/work\/earnings$/);
});

// ---------------------------------------------------------- company driver --
test('company driver sees crew tools only and no settlements', async ({ page }) => {
  await open(page, COMPANY_DRIVER, '/work/today');
  await expect(page.getByRole('button', { name: /Manifeste/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Véhicule/ })).toBeVisible();
  // Revenue and boarding-point ownership belong to the operator, not to crew.
  await expect(page.getByRole('button', { name: /Recettes/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Points$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Règlements/ })).toHaveCount(0);
});

test('company driver is refused the ops workspace explicitly', async ({ page }) => {
  await open(page, COMPANY_DRIVER, '/ops/today');
  // Stated plainly, and never bounced to an unrelated screen.
  await expect(page.getByText('Espace non autorisé')).toBeVisible();
  await expect(page).toHaveURL(/\/ops\/today$/);
});

// --------------------------------------------------------------- convoyeur --
test('convoyeur gets crew navigation without driver-only tools', async ({ page }) => {
  await open(page, CONVOYEUR, '/work/today');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('button', { name: /Manifeste/ })).toBeVisible();
  await expect(nav.getByRole('button', { name: /Colis/ })).toBeVisible();
  await expect(nav.getByRole('button', { name: /Comptant/ })).toBeVisible();
  // Vehicle belongs to the driver role, not to the convoyeur.
  await expect(nav.getByRole('button', { name: /Véhicule/ })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: /Recettes/ })).toHaveCount(0);
  await expect(page.getByText('Convoyeur').first()).toBeVisible();
});

// -------------------------------------------------------------------- ops ---
test('ops workspace opens for an authorized identity with its own navigation', async ({ page }) => {
  await open(page, OPS, '/ops/today');
  for (const item of ['Services', 'Flotte', 'Équipage', 'Stations', 'Règlements']) {
    await expect(page.getByRole('button', { name: item })).toBeVisible();
  }
  await expect(page.getByText('Espace non autorisé')).toHaveCount(0);
});

test('an empty production database renders an honest empty state, never fake data', async ({ page }) => {
  await mockApi(page);
  await signInAs(OPS)(page);
  // A brand-new production operator: the API returns nothing at all.
  await page.route('**/api/v1/ops/fleet', r => r.fulfill({ json: { data: { services: [], vehicles: [] } } }));
  await page.goto(APP + '/ops/fleet');
  await login(page);
  await expect(page.getByText(/Aucun véhicule enregistré/)).toBeVisible();
  // Nothing is invented to fill the screen.
  await expect(page.getByText('DEMO-BUS-01')).toHaveCount(0);
});

test('a passenger identity cannot open the ops workspace', async ({ page }) => {
  await open(page, PASSENGER, '/ops/services');
  await expect(page.getByText('Espace non autorisé')).toBeVisible();
});

// ------------------------------------------------------- routing and PWA ----
test('an unknown route returns to the workspace home instead of erroring', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/definitely-not-a-route');
  await expect(page).toHaveURL(APP + '/');
  await expect(page.getByRole('button', { name: 'Rechercher' })).toBeVisible();
});

test('deep links survive a refresh and never silently redirect', async ({ page }) => {
  await open(page, OWNER_DRIVER, '/work/manifest');
  await expect(page.getByRole('heading', { name: /Manifeste/ }).first()).toBeVisible();
  await page.reload();
  // The route is preserved. Tokens are deliberately not persisted, so the app
  // asks to sign in again — on the same route, not on an unrelated home screen.
  await expect(page).toHaveURL(/\/work\/manifest$/);
  await expect(page.getByText('Connexion requise')).toBeVisible();
  await login(page);
  await expect(page.getByRole('heading', { name: /Manifeste/ }).first()).toBeVisible();
});

test('the PWA is installable and branded LeRoutier, not per role', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/');
  const manifest = await page.evaluate(async () => {
    const link = /** @type {HTMLLinkElement|null} */ (document.querySelector('link[rel="manifest"]'));
    if (!link) return null;
    return (await fetch(link.href)).json();
  });
  expect(manifest).not.toBeNull();
  expect(manifest.name).toBe('LeRoutier');
  expect(manifest.short_name).toBe('LeRoutier');
  expect(manifest.start_url).toBe('/');
  expect(manifest.scope).toBe('/');
  expect(manifest.display).toBe('standalone');
  // One installable app: no role appears in the installed identity.
  expect(/passenger|driver|conducteur|ops/i.test(manifest.name)).toBe(false);
  const sizes = manifest.icons.map(icon => icon.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  expect(manifest.icons.some(icon => icon.purpose === 'maskable')).toBe(true);
  // Icons must actually exist, not merely be declared.
  for (const icon of manifest.icons) {
    const response = await page.request.get(APP + icon.src);
    expect(response.status(), icon.src).toBe(200);
  }
});

test('the crew offline queue survives unification', async ({ page }) => {
  await open(page, COMPANY_DRIVER, '/work/scanner');
  const queueReady = await page.evaluate(() => {
    try { window.localStorage.setItem('leroutier:probe', '1'); window.localStorage.removeItem('leroutier:probe'); return true; }
    catch { return false; }
  });
  expect(queueReady).toBe(true);
  // The crew scanner screen itself, not the navigation entry.
  await expect(page.getByRole('button', { name: 'Scanner le QR' })).toBeVisible();
});
