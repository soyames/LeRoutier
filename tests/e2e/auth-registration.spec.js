import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// Email/password registration and sign-in, the avatar, and the profile
// lifecycle — over mocked Firebase identitytoolkit endpoints, so no real
// provider or account is ever touched. The LeRoutier side is the real one:
// /auth/config, /me provisioning and the profile PATCH.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP = 'http://127.0.0.1:4173';
const FIREBASE_HOST = /^(?:[a-z0-9-]+\.)*(?:googleapis\.com|google\.com|firebaseapp\.com|gstatic\.com)$/i;
const FIREBASE = {
  apiKey: 'browser-test-api-key', authDomain: 'example.firebaseapp.com',
  projectId: 'example-project', appId: '1:1:web:test', providers: ['google'],
};

async function mockFirebase(page, { signUp = null, signIn = null, reset = null, verification = 'sent' } = {}) {
  await mockApi(page);
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
      if (signIn === 'wrong-password') return r.fulfill({ status: 400, json: { error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS', errors: [{ message: 'INVALID_LOGIN_CREDENTIALS' }] } } });
      if (!signIn) return r.abort();
      return r.fulfill({ status: 200, json: { idToken: 'firebase-id-token', email: signIn.email, localId: 'local-1',
        refreshToken: 'refresh', expiresIn: '3600' } });
    }
    if (identityToolkit && url.pathname === '/v1/accounts:lookup') {
      // The SDK refreshes user info right after sign-up/sign-in.
      return r.fulfill({ status: 200, json: { users: [{ localId: 'local-1', email: signUp?.email ?? signIn?.email ?? '',
        displayName: '', providerUserInfo: [], validSince: '0', lastLoginAt: '0', createdAt: '0' }] } });
    }
    if (identityToolkit && url.pathname === '/v1/accounts:sendOobCode') {
      if (!reset) return r.abort();
      return r.fulfill({ status: 200, json: { email: reset.email } });
    }
    if (identityToolkit && url.pathname === '/v1/accounts:update') {
      // applyActionCode, the exchange behind /verify-email.
      if (verification === 'invalid') return r.fulfill({ status: 400, json: { error: { code: 400, message: 'INVALID_OOB_CODE', errors: [{ message: 'INVALID_OOB_CODE' }] } } });
      return r.fulfill({ status: 200, json: { email: signUp?.email ?? signIn?.email ?? 'verifiee@example.com' } });
    }
    return r.abort();
  });
  // The verification email endpoint: the token's claims are the address, so
  // the fixture answers the same generic shape the API does.
  if (verification) {
    await page.route('**/api/v1/auth/email-verification', r => r.fulfill({ json: { data: { status: verification === 'invalid' ? 'sent' : verification } } }));
  }
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: { demoLogin: false, firebase: FIREBASE } } }));
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
  // The privacy center's read endpoints answer minimally for this fixture.
  const emptyPrivacy = { categories: [], retention: [], deletion: null, account: {} };
  await page.route('**/api/v1/me/privacy', r => r.fulfill({ json: { data: emptyPrivacy } }));
  await page.route('**/api/v1/me/consents', r => r.fulfill({ json: { data: [] } }));
}

test('a new user creates an account, is asked to verify the address, then lands connected and complete', async ({ page }) => {
  await mockFirebase(page, { signUp: { email: 'nouveau@example.com' }, signIn: { email: 'nouveau@example.com' } });
  await mockIdentity(page);
  await page.goto(APP + '/account');
  // The entry screen offers both providers.
  await expect(page.getByRole('button', { name: 'Continuer avec Google' })).toBeVisible();
  await page.getByRole('button', { name: 'Pas encore de compte ? Créer un compte' }).click();
  await expect(page.getByRole('heading', { name: 'Créer un compte' })).toBeVisible();
  // Terms and privacy are reachable from the registration screen.
  await expect(page.getByRole('link', { name: 'conditions d’utilisation' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'politique de confidentialité' })).toBeVisible();
  await page.getByLabel('Nom complet').fill('Yao Sossou');
  await page.getByLabel('Téléphone').fill('+229 97000042');
  await page.getByLabel('Adresse e-mail').fill('nouveau@example.com');
  await page.getByLabel('Mot de passe').fill('secret-mot-de-passe');
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  // A brand-new password account is NOT a signed-in LeRoutier account yet:
  // the confirmation email goes out and the check-your-email panel appears.
  await expect(page.getByRole('heading', { name: 'Confirmez votre adresse e-mail' })).toBeVisible();
  await expect(page.getByText(/Compte créé\. Nous avons envoyé un lien de confirmation à votre adresse e-mail/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Déconnexion' })).toHaveCount(0);
  // The resend path re-authenticates with the password, sends again and stays
  // signed out — no half-authenticated state.
  await page.getByLabel('Mot de passe (pour renvoyer le lien)').fill('secret-mot-de-passe');
  await page.getByRole('button', { name: 'Renvoyer l’e-mail de confirmation' }).click();
  await expect(page.getByText(/Un nouveau lien de confirmation a été envoyé à votre adresse e-mail/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Déconnexion' })).toHaveCount(0);
  // Back to the entry, then a verified sign-in: the name and phone typed at
  // registration land in the profile, so the account arrives complete.
  await page.getByRole('button', { name: 'Retour à la connexion' }).click();
  await expect(page.getByText('Bienvenue sur LeRoutier')).toBeVisible();
  await page.getByLabel('Adresse e-mail').fill('nouveau@example.com');
  await page.getByLabel('Mot de passe').fill('secret-mot-de-passe');
  await page.getByRole('button', { name: 'Se connecter avec mon adresse e-mail' }).click();
  await expect(page.getByRole('button', { name: 'Déconnexion' })).toBeVisible();
  await expect(page.getByText('Yao Sossou').first()).toBeVisible();
  // The avatar now shows the user's initials, never "LR".
  await expect(page.getByText('YS')).toBeVisible();
});

test('signing in before confirming the address shows the confirm-email panel, never a session', async ({ page }) => {
  await mockFirebase(page, { signIn: { email: 'nouveau@example.com' } });
  // The server-side gate: /me refuses with EMAIL_NOT_VERIFIED. Registered
  // after mockApi's /me fixture, so this refusal wins.
  await page.route('**/api/v1/me', r => r.fulfill({ status: 403, json: { error: { code: 'EMAIL_NOT_VERIFIED', message: 'Confirm your email address before signing in.' } } }));
  await page.goto(APP + '/account');
  await page.getByLabel('Adresse e-mail').fill('nouveau@example.com');
  await page.getByLabel('Mot de passe').fill('secret-mot-de-passe');
  await page.getByRole('button', { name: 'Se connecter avec mon adresse e-mail' }).click();
  await expect(page.getByRole('heading', { name: 'Confirmez votre adresse e-mail' })).toBeVisible();
  await expect(page.getByText('Confirmez votre adresse e-mail avant de vous connecter.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Renvoyer l’e-mail de confirmation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Déconnexion' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retour à la connexion' }).click();
  await expect(page.getByText('Bienvenue sur LeRoutier')).toBeVisible();
});

test('sign-in with email works; a wrong password is explained in product language', async ({ page }) => {
  await mockFirebase(page, { signIn: { email: 'nouveau@example.com' } });
  await mockIdentity(page, { needsProfile: false });
  await page.goto(APP + '/account');
  await page.getByLabel('Adresse e-mail').fill('nouveau@example.com');
  await page.getByLabel('Mot de passe').fill('secret-mot-de-passe');
  await page.getByRole('button', { name: 'Se connecter avec mon adresse e-mail' }).click();
  await expect(page.getByText('Test Identity').first()).toBeVisible();
  // Wrong password → clear French guidance, no provider internals.
  await page.getByRole('button', { name: 'Déconnexion' }).click();
  await page.route('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword*', r =>
    r.fulfill({ status: 400, json: { error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } } }));
  await page.getByLabel('Adresse e-mail').fill('nouveau@example.com');
  await page.getByLabel('Mot de passe').fill('mauvais');
  await page.getByRole('button', { name: 'Se connecter avec mon adresse e-mail' }).click();
  await expect(page.getByText('Adresse e-mail ou mot de passe incorrect.')).toBeVisible();
});

test('password reset asks for the email and confirms the send without leaking provider internals', async ({ page }) => {
  await mockFirebase(page, { reset: { email: 'nouveau@example.com' } });
  await page.goto(APP + '/account');
  await page.getByRole('button', { name: 'Mot de passe oublié ?' }).click();
  await page.getByLabel('Adresse e-mail').fill('nouveau@example.com');
  await page.getByRole('button', { name: 'Envoyer le lien' }).click();
  await expect(page.getByText(/un e-mail de réinitialisation a été envoyé/)).toBeVisible();
  const panel = await page.locator('.card').first().innerText();
  expect(panel).not.toMatch(/identitytoolkit|firebase|oob/i);
});

test('the anonymous header shows a neutral account action, never "LR"', async ({ page }) => {
  await mockFirebase(page);
  await page.goto(APP + '/account');
  await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible();
  const header = await page.locator('.lr-header').innerText();
  expect(header).not.toContain('LR');
  // Tapping it leads to the account screen with the full entry experience.
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByText('Bienvenue sur LeRoutier')).toBeVisible();
});

test('the account menu offers profile, privacy and logout', async ({ page }) => {
  await mockFirebase(page, { signIn: { email: 'nouveau@example.com' } });
  await mockIdentity(page, { needsProfile: false });
  await page.goto(APP + '/account');
  await page.getByLabel('Adresse e-mail').fill('nouveau@example.com');
  await page.getByLabel('Mot de passe').fill('secret-mot-de-passe');
  await page.getByRole('button', { name: 'Se connecter avec mon adresse e-mail' }).click();
  await page.getByRole('button', { name: 'Compte de Test Identity' }).click();
  await expect(page.getByRole('menuitem', { name: 'Mon profil' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Confidentialité et données' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Déconnexion' }).click();
  await expect(page.getByText('Bienvenue sur LeRoutier')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible();
});
