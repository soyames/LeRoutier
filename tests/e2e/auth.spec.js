import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';
import fs from 'node:fs';

// Authentication as a user meets it.
//
// The provider's own protocol is Google's business and is not re-implemented
// here; what matters to LeRoutier is everything around it — that sign-in is
// refused when unconfigured, that the provider is named, that a Google
// identity grants no LeRoutier privilege, and that signing out leaves nothing
// behind. Token verification itself is covered in services/api/tests.
//
// Never record tokens, authorization headers or provider traffic in artifacts.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const FIREBASE = {
  apiKey: 'browser-test-api-key', authDomain: 'example.firebaseapp.com',
  projectId: 'example-project', appId: '1:1:web:test', providers: ['google'],
};

/** No test may reach Google. A blocked call is a failed sign-in, never a real one. */
async function isolateProvider(page) {
  await page.route(/googleapis\.com|google\.com|firebaseapp\.com|gstatic\.com/, r => r.abort());
}

/** Signs in through the development path: the same /me and the same role gating. */
async function signedIn(page, port, { role = 'passenger', needsProfile = false, routes = null } = {}) {
  await mockApi(page);
  await isolateProvider(page);
  // Registered after the fixture so they win: Playwright tries the most
  // recently added handler first.
  if (routes) await routes(page);
  const user = {
    id: '00000000-0000-4000-8000-000000000099',
    display_name: needsProfile ? '' : 'Test Identity',
    role, operator_id: role === 'passenger' ? null : '00000000-0000-4000-8000-000000000001',
    needs_profile: needsProfile,
  };
  let current = user;
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: current } } }));
  await page.route('**/api/v1/me', async r => {
    if (r.request().method() === 'PATCH') {
      const body = r.request().postDataJSON();
      expect(Object.keys(body).sort()).toEqual(['displayName', 'phone']);
      current = { ...current, display_name: body.displayName, needs_profile: false };
    }
    await r.fulfill({ json: { data: current } });
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
}

// ----------------------------------------------------------- fail closed --
test('production login unavailable fails closed without token input or demo login', async ({ page }) => {
  await mockApi(page);
  await isolateProvider(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: { demoLogin: false, firebase: null } } }));
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.getByRole('button', { name: 'Connexion indisponible' })).toBeDisabled();
  await expect(page.getByText('La connexion sécurisée n’est pas encore configurée.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connexion de développement' })).toHaveCount(0);
  // No password field, no token box: there is no second way in.
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});

test('a configured provider is offered by name', async ({ page }) => {
  await mockApi(page);
  await isolateProvider(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: { demoLogin: false, firebase: FIREBASE } } }));
  await page.goto('http://127.0.0.1:4173/');
  // A person about to hand over an identity is told to whom.
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toBeEnabled();
  await expect(page.getByText('La connexion sécurisée n’est pas encore configurée.')).toHaveCount(0);
});

test('the browser is never given anything but the four public identifiers', async ({ page }) => {
  await mockApi(page);
  await isolateProvider(page);
  let published = null;
  await page.route('**/api/v1/auth/config', async r => {
    published = { demoLogin: false, firebase: FIREBASE };
    await r.fulfill({ json: { data: published } });
  });
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toBeVisible();
  const payload = /** @type {any} */ (published);
  expect(payload, 'the app must have asked for its sign-in configuration').toBeTruthy();
  expect(Object.keys(payload.firebase).sort()).toEqual(['apiKey', 'appId', 'authDomain', 'projectId', 'providers']);
});

// ------------------------------------------------------------- the session --
test('a passenger completes their profile and signs out leaving nothing behind', async ({ page }) => {
  await signedIn(page, 4173, { needsProfile: true });
  await expect(page.getByRole('heading', { name: 'Complétez votre profil' })).toBeVisible();
  await page.getByLabel('Départ', { exact: true }).selectOption('place');
  await page.getByLabel('Ville de départ').fill('Cotonou'); await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').fill('Parakou'); await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
  await expect(page.getByRole('button', { name: 'Complétez votre profil' })).toBeDisabled();
  await page.getByLabel('Nom complet').fill('Voyageur Test');
  await page.getByLabel('Téléphone', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Enregistrer mon profil' }).click();
  await expect(page.getByRole('button', { name: 'Choisir ce trajet' })).toBeEnabled();

  await page.getByRole('button', { name: 'Déconnexion' }).click();
  await expect(page.getByRole('button', { name: 'Connexion indisponible' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Se connecter pour réserver' })).toBeEnabled();

  // Signing out leaves no authentication material anywhere a next user could
  // reach it — this is a shared handset at a station, not a personal laptop.
  const residue = await page.evaluate(() => {
    const keys = [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
    return keys.filter(k => /firebase|token|auth|oidc/i.test(k));
  });
  expect(residue).toEqual([]);
});

// ------------------------------------------------------- roles are ours ----
test('driver app shows explicit unprovisioned state for passenger identity', async ({ page }) => {
  await signedIn(page, 4174);
  await expect(page.getByText('Votre compte passager n’est pas encore provisionné comme équipage. Créez un compte opérateur ou demandez votre provisionnement.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Déconnexion' })).toBeVisible();
});

test('ops app denies passenger identity and hides provisioning controls', async ({ page }) => {
  await signedIn(page, 4175);
  await expect(page.getByText('Cet espace est réservé aux opérateurs de transport.')).toBeVisible();
  await expect(page.getByText('Provisionner un agent Ops', { exact: true })).toHaveCount(0);
});

test('approved driver sees assignment and signout clears privileged data', async ({ page }) => {
  await signedIn(page, 4174, { role: 'driver' });
  await expect(page.getByText('à bord').first()).toBeVisible();
  await page.getByRole('button', { name: 'Déconnexion' }).click();
  await expect(page.getByText('à bord')).toHaveCount(0);
});

test('operator ops can create a vehicle with a stable retry key and no fake success', async ({ page }) => {
  let attempts = 0, firstKey;
  await signedIn(page, 4175, { role: 'ops', routes: async p => {
    await p.route('**/api/v1/ops/provisioning', r => r.fulfill({ json: { data: {
      operators: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Test operator' }],
      users: [], routes: [], vehicles: [], places: [], stops: [] } } }));
    await p.route('**/api/v1/ops/vehicles', r => {
      const key = r.request().headers()['idempotency-key'];
      if (!attempts) firstKey = key; else expect(key === firstKey).toBe(true);
      expect(r.request().postDataJSON()).toEqual({ operatorId: '00000000-0000-4000-8000-000000000001', registration: 'TEST-01', capacity: 12 });
      return ++attempts === 1
        ? r.fulfill({ status: 503, json: { error: { message: 'Réessayez.' } } })
        : r.fulfill({ json: { data: { id: 'created' } } });
    });
  } });
  // Sessions are memory-only: navigate client-side, never reload the app.
  await page.getByRole('button', { name: 'Paramètres' }).click();
  await expect(page.getByText('Créer un opérateur', { exact: true })).toHaveCount(0);
  await page.getByText('Ajouter un véhicule', { exact: true }).click();
  await page.getByLabel('Immatriculation').fill('TEST-01');
  await page.getByLabel('Nombre de places').fill('12');
  const form = page.locator('details').filter({ has: page.getByText('Ajouter un véhicule', { exact: true }) });
  await form.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Réessayez.');
  // A failed create must never read as a success.
  await expect(page.getByText('Création enregistrée.')).toHaveCount(0);
  await form.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Création enregistrée.')).toBeVisible();
  expect(attempts).toBe(2);
});

// ---------------------------------------------------------- legal pages ----
// Google Auth Platform will not let an app offer Google Sign-In until its
// privacy policy and terms resolve. They must also be readable without an
// account — a person deciding whether to hand over an identity cannot be asked
// to sign in first. These pages are routed above the app shell in main.jsx.
const UNIFIED = 'http://127.0.0.1:4176';

test('the pages Google requires resolve without an account', async ({ page }) => {
  await mockApi(page);
  await isolateProvider(page);
  for (const [path, heading] of [
    ['/privacy', 'Politique de confidentialité'],
    ['/terms', 'Conditions d’utilisation et de réservation'],
    ['/legal', 'Mentions légales'],
    ['/cancellations', 'Annulations et remboursements'],
    ['/cookies', 'Cookies et technologies similaires'],
  ]) {
    await page.goto(UNIFIED + path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    // No sign-in card is pushed in front of a legal page.
    await expect(page.getByRole('button', { name: /Se connecter/ })).toHaveCount(0);
    await expect(page).toHaveURL(UNIFIED + path);
  }
});

test('the privacy policy and the implementation agree about Google', async ({ page }) => {
  await mockApi(page);
  await isolateProvider(page);
  await page.goto(UNIFIED + '/privacy');
  const text = await page.getByRole('main').innerText();
  // The published policy promises identity and basic profile only, and names
  // the services it deliberately does not ask for. The code must not exceed
  // that: this test is what keeps the two from drifting apart.
  expect(text).toMatch(/Firebase Authentication/);
  expect(text).toMatch(/Gmail/);
  // Public copy stays product language: no internal authorization wording.
  expect(text).not.toMatch(/rôles LeRoutier restent déterminés dans notre propre système/);
  expect(text).not.toMatch(/OpenRouter|Gemini/);
});

test('the scopes requested never exceed what the policy describes', async () => {
  // Asserted against the source, because a scope added in a hurry is exactly
  // the change that would quietly outgrow the published policy.
  const client = fs.readFileSync('packages/config/src/firebase.js', 'utf8');
  const scopes = [...client.matchAll(/addScope\('([^']+)'\)/g)].map(m => m[1]).sort();
  expect(scopes).toEqual(['email', 'openid', 'profile']);
  // Checked on the requested scopes themselves, not on prose: the file names
  // the services it deliberately does not ask for, and a comment must not be
  // able to fail — or to pass — a security assertion.
  for (const scope of scopes) {
    expect(scope, 'an API scope grants access to data, not just identity').not.toMatch(/googleapis\.com|https?:/);
  }
});
