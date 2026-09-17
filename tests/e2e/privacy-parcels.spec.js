import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// The Privacy Center deep link and the geography-backed parcel city picker:
// real routes, real data endpoints, no blank pages.
const APP = 'http://127.0.0.1:4176';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const me = extra => ({ id: id(99), display_name: 'Test Identity', needs_profile: false, ...extra });
const PASSENGER = me({ role: 'passenger', operator_id: null });

async function signedIn(page) {
  await mockApi(page);
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: PASSENGER } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: PASSENGER } }));
  const emptyPrivacy = { categories: [{ category: 'identité de compte', count: 1 }], retention: [{ data_category: 'raw_gps', retention_days: 30, action: 'delete' }], deletion: null, account: {} };
  await page.route('**/api/v1/me/privacy', r => r.fulfill({ json: { data: emptyPrivacy } }));
  await page.route('**/api/v1/me/consents', r => r.fulfill({ json: { data: [] } }));
  await page.goto(APP + '/account');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
}

test('the account menu privacy link opens the real Privacy Center on a stable route', async ({ page }) => {
  await signedIn(page);
  await page.getByRole('button', { name: `Compte de ${PASSENGER.display_name}` }).click();
  await page.getByRole('menuitem', { name: 'Confidentialité et données' }).click();
  await expect(page).toHaveURL(/\/account\/privacy/);
  await expect(page.getByText('Confidentialité et données').first()).toBeVisible();
  await expect(page.getByText('Mes données', { exact: true })).toBeVisible();
  await expect(page.getByText('Télécharger mes données', { exact: true })).toBeVisible();
  await expect(page.getByText('Supprimer mon compte', { exact: true })).toBeVisible();
  // Deep link and back work.
  await page.goto(APP + '/account/privacy');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  await expect(page.getByText('Politique de conservation des données', { exact: true })).toBeVisible();
  await page.goBack();
});

test('the parcel city picker lists Benin communes even with no routes', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/routes', r => r.fulfill({ json: { data: [] } }));
  const communes = ['Cotonou', 'Parakou', 'Bohicon', 'Natitingou', 'Malanville', 'Grand-Popo', 'Sakété'];
  await page.route('**/api/v1/places?type=commune', r => r.fulfill({ json: { data: communes.map((name, i) => ({ id: `00000000-0000-4000-b000-0000000002${i}1`, name, kind: 'city', parent_id: null, latitude: 6.4, longitude: 2.4 })) } }));
  await page.route('**/api/v1/places?type=department', r => r.fulfill({ json: { data: [] } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: PASSENGER } }));
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: PASSENGER } } }));
  await page.goto(APP + '/parcels');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  const origin = page.getByLabel('Ville de départ', { exact: true });
  await expect(origin).toBeVisible();
  for (const city of communes) await expect(origin.locator('option', { hasText: city })).toHaveCount(1);
  // Selecting a city without a stop states the service availability honestly.
  await origin.selectOption({ label: 'Natitingou' });
  await expect(page.getByText('Aucun service colis pour cette ville pour le moment.')).toBeVisible();
});

test('in-app notification centre and unread badge work end to end', async ({ page }) => {
  await mockApi(page);
  const notifications = [{ id: 'n1', event_type: 'booking.held', category: 'operational', severity: 'info', read_at: null, created_at: '2026-09-17T10:00:00Z' }];
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session', user: PASSENGER } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: PASSENGER } }));
  await page.route('**/api/v1/notifications?unread=true', r => r.fulfill({ json: { data: [notifications[0]] } }));
  await page.route('**/api/v1/notifications', r => r.fulfill({ json: { data: notifications } }));
  await page.goto(APP + '/account');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  await expect(page.getByRole('button', { name: /Notifications \(1 non lues\)/ })).toBeVisible();
  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(page.getByRole('heading', { name: /Notifications/ })).toBeVisible();
});
