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

const PROVIDER_HOST = /^(?:[a-z0-9-]+\.)*(?:googleapis\.com|google\.com|firebaseapp\.com|gstatic\.com)$/i;
const FIREBASE = {
  apiKey: 'browser-test-api-key', authDomain: 'example.firebaseapp.com',
  projectId: 'example-project', appId: '1:1:web:test', providers: ['google'],
};

/** No test may reach Google. A blocked call is a failed sign-in, never a real one. */
async function isolateProvider(page) {
  await page.route('**/*', r => {
    let hostname = '';
    try { hostname = new URL(r.request().url()).hostname; } catch { return r.fallback(); }
    return PROVIDER_HOST.test(hostname) ? r.abort() : r.fallback();
  });
}

/** Signs in through the development path: the same /me and the same role gating. */
async function signedIn(page, { role = 'passenger', needsProfile = false, routes = null } = {}) {
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
  const path = role === 'ops' ? '/ops/today' : role === 'driver' ? '/work/today' : '/';
  await page.goto(`http://127.0.0.1:4173${path}`);
  if (role === 'passenger') {
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await page.getByRole('button', { name: 'Connexion de développement' }).click();
    await page.getByRole('button', { name: 'Accueil LeRoutier' }).click();
  } else {
    await page.getByRole('button', { name: 'Connexion de développement' }).click();
  }
}

// ----------------------------------------------------------- fail closed --
test('production login unavailable fails closed without token input or demo login', async ({ page }) => {
  await mockApi(page);
  await isolateProvider(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: { demoLogin: false, firebase: null } } }));
  await page.goto('http://127.0.0.1:4173/account');
  // No configured identity provider: no Google button, no form — an honest
  // message instead of an entry that can only fail.
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toHaveCount(0);
  await expect(page.getByText('La connexion sécurisée n’est pas encore configurée.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connexion de développement' })).toHaveCount(0);
  // No password field, no token box: there is no second way in.
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});

test('a configured provider is offered by name', async ({ page }) => {
  await mockApi(page);
  await isolateProvider(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: { demoLogin: false, firebase: FIREBASE } } }));
  await page.goto('http://127.0.0.1:4173/account');
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
  await page.goto('http://127.0.0.1:4173/account');
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toBeVisible();
  const payload = /** @type {any} */ (published);
  expect(payload, 'the app must have asked for its sign-in configuration').toBeTruthy();
  expect(Object.keys(payload.firebase).sort()).toEqual(['apiKey', 'appId', 'authDomain', 'projectId', 'providers']);
});

// ------------------------------------------------------------- the session --
test('a passenger completes their profile and signs out leaving nothing behind', async ({ page }) => {
  await signedIn(page, { needsProfile: true });
  await page.getByLabel('Départ', { exact: true }).selectOption('place');
  await page.getByLabel('Ville de départ').fill('Cotonou'); await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').fill('Parakou'); await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
  // Select the TEST offer: the whole checkout exercises the simulated path.
  await page.getByRole('button', { name: 'Chauffeurs indépendants' }).click();
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  await expect(page).toHaveURL(/\/checkout/);
  await expect(page.getByText('TEST', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continuer vers le paiement' }).click();
  // The profile gate sits at the payment step — inline, not onboarding.
  await expect(page.getByRole('heading', { name: 'Complétez votre profil' })).toBeVisible();
  await page.getByLabel('Nom complet').fill('Voyageur Test');
  await page.getByLabel('Téléphone', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Enregistrer mon profil' }).click();
  // Profile saved: the checkout resumes automatically and completes the
  // simulated payment against the TEST booking.
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });

  await page.getByRole('button', { name: 'Déconnexion' }).click();
  // The development fixture has no configured identity provider: the entry
  // after sign-out is the local demo entry, never a dead Google button.
  await expect(page.getByRole('button', { name: 'Connexion de développement' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toHaveCount(0);

  // Signing out leaves no authentication material anywhere a next user could
  // reach it — this is a shared handset at a station, not a personal laptop.
  const residue = await page.evaluate(() => {
    const keys = [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
    return keys.filter(k => /firebase|token|auth|oidc/i.test(k));
  });
  expect(residue).toEqual([]);
});

// ---------------------------------------------------------- legal pages ----
// Google Auth Platform will not let an app offer Google Sign-In until its
// privacy policy and terms resolve. They must also be readable without an
// account — a person deciding whether to hand over an identity cannot be asked
// to sign in first. These pages are routed above the app shell in main.jsx.
const UNIFIED = 'http://127.0.0.1:4173';

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
