import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// The Google feature gate, from the user's side of the screen.
//
// Production hides Google sign-in because its OAuth callback is rejected on
// the installed PWA. The provider list published by /auth/config is the one
// source of truth: when it does not include 'google', no Google entry may
// appear — no button, no orphan "ou" separator — and e-mail/password remains
// the whole entry experience. When it does include 'google', the existing
// Google UI renders (the enabled side is also covered by auth.spec.js and
// auth-registration.spec.js, whose fixtures publish the provider).
//
// Nothing here touches a real Google account; the Firebase-facing endpoints
// are mocked exactly as in auth-registration.spec.js.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP = 'http://127.0.0.1:4173';
const FIREBASE_HOST = /^(?:[a-z0-9-]+\.)*(?:googleapis\.com|google\.com|firebaseapp\.com|gstatic\.com)$/i;

/** /auth/config without the google provider — the production default. */
const HIDDEN = {
  demoLogin: false,
  firebase: { apiKey: 'browser-test-api-key', authDomain: 'example.firebaseapp.com',
    projectId: 'example-project', appId: '1:1:web:test', providers: [] },
};

async function mockFirebase(page, { published = HIDDEN, signUp = null, signIn = null } = {}) {
  await mockApi(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: published } }));
  await page.route('**/*', async r => {
    let url;
    try { url = new URL(r.request().url()); } catch { return r.fallback(); }
    if (!FIREBASE_HOST.test(url.hostname)) return r.fallback();
    const identityToolkit = url.hostname === 'identitytoolkit.googleapis.com';
    if (identityToolkit && url.pathname === '/v1/accounts:signUp') {
      if (!signUp) return r.abort();
      return r.fulfill({ status: 200, json: { idToken: 'firebase-id-token', email: signUp.email, localId: 'local-1',
        refreshToken: 'refresh', expiresIn: '3600' } });
    }
    if (identityToolkit && url.pathname === '/v1/accounts:signInWithPassword') {
      if (!signIn) return r.abort();
      return r.fulfill({ status: 200, json: { idToken: 'firebase-id-token', email: signIn.email, localId: 'local-1',
        refreshToken: 'refresh', expiresIn: '3600' } });
    }
    if (identityToolkit && url.pathname === '/v1/accounts:lookup') {
      return r.fulfill({ status: 200, json: { users: [{ localId: 'local-1', email: signUp?.email ?? signIn?.email ?? '',
        displayName: '', providerUserInfo: [], validSince: '0', lastLoginAt: '0', createdAt: '0' }] } });
    }
    return r.abort();
  });
}

/** The real /me contract: provision a new passenger, accept the PATCH. */
async function mockIdentity(page, { needsProfile = true } = {}) {
  let current = { id: '00000000-0000-4000-8000-000000000099', display_name: needsProfile ? '' : 'Test Identity',
    role: 'passenger', operator_id: null, needs_profile: needsProfile };
  await page.route('**/api/v1/me', async r => {
    if (r.request().method() === 'PATCH') {
      const body = r.request().postDataJSON();
      current = { ...current, display_name: body.displayName, needs_profile: false };
    }
    await r.fulfill({ json: { data: current } });
  });
}

test('a disabled provider leaves no Google entry and no orphan separator', async ({ page }) => {
  await mockFirebase(page, { signIn: { email: 'voyageur@example.com' } });
  await mockIdentity(page, { needsProfile: false });
  await page.goto(APP + '/account');

  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toHaveCount(0);
  await expect(page.getByText('ou', { exact: true })).toHaveCount(0);
  // The entry is e-mail/password, whole and usable.
  await expect(page.getByLabel('Adresse e-mail')).toBeVisible();
  await expect(page.getByLabel('Mot de passe')).toBeVisible();
  await page.getByLabel('Adresse e-mail').fill('voyageur@example.com');
  await page.getByLabel('Mot de passe').fill('secret-mot-de-passe');
  await page.getByRole('button', { name: 'Se connecter avec mon adresse e-mail' }).click();
  await expect(page.getByText('Test Identity').first()).toBeVisible({ timeout: 15000 });
  // Logout returns to the same e-mail-only entry.
  await page.getByRole('button', { name: 'Compte de Test Identity' }).click();
  await page.getByRole('menuitem', { name: 'Déconnexion' }).click();
  await expect(page.getByText('Bienvenue sur LeRoutier')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toHaveCount(0);
});

test('an absent provider list fails hidden on the client too', async ({ page }) => {
  // An older API or a fixture that says nothing about providers must hide
  // Google, never show it by default.
  const withoutProviders = /** @type {any} */ (Object.fromEntries(Object.entries(HIDDEN.firebase).filter(([key]) => key !== 'providers')));
  await mockFirebase(page, { published: { demoLogin: false, firebase: withoutProviders } });
  await page.goto(APP + '/account');
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toHaveCount(0);
  await expect(page.getByLabel('Adresse e-mail')).toBeVisible();
  await expect(page.getByText('ou', { exact: true })).toHaveCount(0);
});

test('registration and profile completion work with Google hidden', async ({ page }) => {
  await mockFirebase(page, { signUp: { email: 'nouveau@example.com' } });
  await mockIdentity(page);
  await page.goto(APP + '/account');
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pas encore de compte ? Créer un compte' }).click();
  await expect(page.getByRole('heading', { name: 'Créer un compte' })).toBeVisible();
  await page.getByLabel('Nom complet').fill('Yao Sossou');
  await page.getByLabel('Téléphone').fill('+229 97000042');
  await page.getByLabel('Adresse e-mail').fill('nouveau@example.com');
  await page.getByLabel('Mot de passe').fill('secret-mot-de-passe');
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  // Registration carries name and phone into the profile; the account lands
  // connected and complete without any Google step.
  await expect(page.getByRole('button', { name: 'Déconnexion' })).toBeVisible();
  await expect(page.getByText('Yao Sossou').first()).toBeVisible();
});

test('an enabled provider list still renders the Google entry', async ({ page }) => {
  await mockFirebase(page, { published: { demoLogin: false, firebase: { ...HIDDEN.firebase, providers: ['google'] } } });
  await page.goto(APP + '/account');
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toBeEnabled();
  await expect(page.getByText('ou', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Adresse e-mail')).toBeVisible();
});
