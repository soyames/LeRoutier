import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// Seat choice, reputation and declared equipment, as a passenger meets them.
//
// The rules under test are the honest ones: an average is not shown until it
// means something, equipment is the operator's claim rather than ours, and a
// seat is optional so nobody is blocked by a grid they did not ask for.
const APP = 'http://127.0.0.1:4173';

async function toResults(page) {
  await mockApi(page);
  await page.goto(APP + '/trips');
  await page.getByLabel('Départ', { exact: true }).selectOption('place');
  const from = page.getByLabel('Ville de départ');
  await from.click(); await from.fill('Cotonou'); await from.press('Enter');
  const to = page.getByLabel('Destination');
  await to.click(); await to.fill('Parakou'); await to.press('Enter');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
}

test('an average appears only once it means something', async ({ page }) => {
  await toResults(page);
  // The company has twelve ratings, so its average is shown.
  await expect(page.getByText('4,5').first()).toBeVisible();
  await expect(page.getByText('(12 avis)').first()).toBeVisible();
  // The TEST operator has one rating, so it shows a count and no average —
  // a single five-star rating is not a reputation.
  await expect(page.getByText(/1 avis · pas encore de moyenne/)).toBeVisible();
  const body = (await page.locator('body').textContent()) ?? '';
  expect(body).not.toMatch(/\b5,0\b/);
});

test('declared equipment is shown as the operator’s claim', async ({ page }) => {
  await toResults(page);
  const equipment = page.getByLabel('Équipements annoncés par l’opérateur').first();
  await expect(equipment).toBeVisible();
  await expect(equipment.getByText('Clim')).toBeVisible();
  await expect(equipment.getByText('USB')).toBeVisible();
});

test('a seat can be chosen at checkout, and skipping it still books', async ({ page }) => {
  const held = [];
  await toResults(page);
  await page.route('**/api/v1/bookings', r => {
    held.push(r.request().postDataJSON());
    return r.fulfill({ json: { data: { id: '00000000-0000-4000-8000-0000000000b1', status: 'held',
      amount_minor: 7500, seat_number: held.at(-1)?.seatNumber ?? 1 } } });
  });
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  const seats = page.getByRole('group', { name: 'Sièges disponibles' });
  await expect(seats).toBeVisible();
  // Choosing is optional and reversible, and an occupied seat cannot be taken.
  await expect(seats.getByRole('button', { name: /Siège 3, occupé/ })).toBeDisabled();
  // A seat freed at this passenger's boarding stop is offered, and says why.
  await expect(seats.getByRole('button', { name: /Siège 5, libre à partir de votre montée/ })).toBeEnabled();
  await seats.getByRole('button', { name: /Siège 5/ }).click();
  await expect(page.getByText('Siège 5 sélectionné.')).toBeVisible();
  await page.getByRole('button', { name: 'Continuer vers le paiement' }).click();
  // The hold happens after the auth gate, so the chosen seat has to survive it.
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  await expect.poll(() => held.length, { timeout: 15000 }).toBeGreaterThan(0);
  expect(held[0].seatNumber).toBe(5);
});

test('a seat taken while deciding is explained, not reported as a full bus', async ({ page }) => {
  await toResults(page);
  await page.route('**/api/v1/bookings', r => r.fulfill({ status: 409,
    json: { error: { code: 'SEAT_TAKEN', message: 'Ce siège vient d’être pris. Choisissez-en un autre.' } } }));
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  await page.getByRole('group', { name: 'Sièges disponibles' }).getByRole('button', { name: /Siège 2/ }).click();
  await page.getByRole('button', { name: 'Continuer vers le paiement' }).click();
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  await expect(page.getByText(/Ce siège vient d’être pris/)).toBeVisible({ timeout: 15000 });
  // The passenger is not told the departure is gone, because it is not.
  await expect(page.getByText(/n’est plus disponible/)).toHaveCount(0);
});
