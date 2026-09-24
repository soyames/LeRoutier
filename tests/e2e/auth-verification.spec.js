import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// The branded /verify-email route: it applies the Firebase oobCode through the
// SDK's own applyActionCode (mocked here at the identitytoolkit boundary), and
// renders an honest confirmation or refusal. No real provider, no real account.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const APP = 'http://127.0.0.1:4173';
const FIREBASE_HOST = /^(?:[a-z0-9-]+\.)*(?:googleapis\.com|google\.com|firebaseapp\.com|gstatic\.com)$/i;
const FIREBASE = {
  apiKey: 'browser-test-api-key', authDomain: 'example.firebaseapp.com',
  projectId: 'example-project', appId: '1:1:web:test', providers: ['google'],
};

async function mockVerify(page, { valid = true } = {}) {
  await mockApi(page);
  await page.route('**/*', async r => {
    let url;
    try { url = new URL(r.request().url()); } catch { return r.fallback(); }
    if (!FIREBASE_HOST.test(url.hostname)) return r.fallback();
    if (url.hostname === 'identitytoolkit.googleapis.com' && url.pathname === '/v1/accounts:update') {
      // applyActionCode exchanges the oobCode here; an invalid or spent code
      // is Firebase's INVALID_OOB_CODE.
      if (!valid) return r.fulfill({ status: 400, json: { error: { code: 400, message: 'INVALID_OOB_CODE', errors: [{ message: 'INVALID_OOB_CODE' }] } } });
      return r.fulfill({ status: 200, json: { email: 'verifiee@example.com' } });
    }
    return r.abort();
  });
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: { demoLogin: false, firebase: FIREBASE } } }));
}

test('a valid oobCode confirms the address and offers sign-in', async ({ page }) => {
  await mockVerify(page);
  await page.goto(APP + '/verify-email?oobCode=VALID-OOB-CODE');
  await expect(page.getByRole('heading', { name: 'Votre adresse e-mail est confirmée.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Se connecter' })).toBeVisible();
  // The single-use code does not linger in the address bar.
  await expect(page).toHaveURL(APP + '/verify-email');
});

test('an invalid or expired code explains itself and routes back to sign-in', async ({ page }) => {
  await mockVerify(page, { valid: false });
  await page.goto(APP + '/verify-email?oobCode=EXPIRED-OOB-CODE');
  await expect(page.getByRole('heading', { name: 'Lien de confirmation invalide' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/expiré ou a déjà été utilisé/);
  await expect(page.getByRole('link', { name: 'Se connecter' })).toBeVisible();
});

test('a missing code is the same honest refusal', async ({ page }) => {
  await mockVerify(page);
  await page.goto(APP + '/verify-email');
  await expect(page.getByRole('heading', { name: 'Lien de confirmation invalide' })).toBeVisible();
});
