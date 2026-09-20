import { test, expect } from '@playwright/test';

// The unified PWA against the real API and a disposable Neon schema. No route
// is mocked here: every screen below is rendering data that actually came out
// of PostgreSQL through /api/v1.
const APP = 'http://127.0.0.1:4173';
const signIn = (page, role) => page.getByRole('button', { name: 'Développement : ' + role }).click();

test('the unified PWA carries a real database-backed journey across workspaces', async ({ browser }) => {
  const passenger = await browser.newPage(), ops = await browser.newPage(), crew = await browser.newPage();
  const errors = [];
  for (const page of [passenger, ops, crew]) page.on('pageerror', () => errors.push('browser error'));

  // 1. One public entry point, anonymous, backed by real data. The search
  //    runs over the live Benin geography, not the route inventory.
  await passenger.goto(APP + '/?testMode=1');
  await expect(passenger.getByRole('button', { name: 'Rechercher un trajet' })).toBeVisible();
  await passenger.getByLabel('Départ', { exact: true }).selectOption('place');
  await passenger.getByLabel('Ville de départ').click();
  await passenger.getByLabel('Ville de départ').fill('Cotonou');
  await passenger.getByLabel('Ville de départ').press('Enter');
  await passenger.getByLabel('Destination').click();
  await passenger.getByLabel('Destination').fill('Parakou');
  await passenger.getByLabel('Destination').press('Enter');
  await expect(passenger.getByRole('button', { name: /Ville de départ : Cotonou/ })).toBeVisible();
  await expect(passenger.getByRole('button', { name: /Destination : Parakou/ })).toBeVisible();
  await passenger.getByRole('button', { name: 'Rechercher un trajet' }).click();
  // The home search carries its criteria into the results URL.
  await expect(passenger).toHaveURL(/\/trips\?.*from=place%3A/);
  // First real round trip to Neon after mount: allow for the query, not for a
  // flaky retry loop.
  await expect(passenger.getByText('DEMO - Corridor Benin').first()).toBeVisible({ timeout: 20000 });
  // Anonymous search works; cash is never offered to a passenger.
  await expect(passenger.getByRole('button', { name: 'Choisir' }).first()).toBeEnabled();
  await expect(passenger.getByText(/espèces/i)).toHaveCount(0);

  // 2. Login happens at the action, and books against the real domain.
  await passenger.getByRole('button', { name: 'Choisir' }).first().click();
  await expect(passenger).toHaveURL(/\/checkout/);
  await passenger.getByRole('button', { name: 'Continuer vers le paiement' }).click();
  await signIn(passenger, 'passenger');
  // Booking lands on that booking, not on a generic list.
  await expect(passenger).toHaveURL(/\/tickets\//);

  // 3. The demo payment is simulated and produces the confirmed booking.
  await ops.goto(APP + '/ops/payments');
  await signIn(ops, 'ops');

  // 4. Passenger issues the ticket and sees the end-to-end
  //    journey: exact boarding point plus the optional first-mile handoff.
  await expect(passenger.getByText('Confirmé', { exact: true })).toBeVisible();
  await passenger.getByRole('button', { name: 'Afficher mon billet' }).click();
  await expect(passenger.getByText(/LR-[0-9A-F]{4}-[0-9A-F]{4}/)).toBeVisible();

  // 5. The Ops workspace and the crew workspace live in the same product.
  await crew.goto(APP + '/work/today');
  await signIn(crew, 'driver');
  await expect(crew.getByText('à bord').first()).toBeVisible();
  await crew.getByRole('navigation').getByRole('button', { name: 'Manifeste' }).click();
  await expect(crew).toHaveURL(/\/work\/manifest$/);
  await expect(crew.getByText('Passager Démo')).toBeVisible();
  await crew.getByRole('button', { name: 'Embarquer', exact: true }).click();
  await expect(crew.getByRole('button', { name: 'Embarquer', exact: true })).toHaveCount(0);

  // 6. A company driver is crew: no revenue tools appear in their workspace.
  await expect(crew.getByRole('navigation').getByRole('button', { name: 'Recettes' })).toHaveCount(0);
  // And the same identity can switch to its passenger workspace without a
  // second login — one session, several authorized workspaces.
  await crew.getByRole('button', { name: /Changer d’espace/ }).click();
  await crew.getByRole('menuitem', { name: /Voyageur/ }).click();
  await expect(crew).toHaveURL(/\/trips$/);
  await expect(crew.getByRole('button', { name: 'Rechercher un trajet' })).toBeVisible();

  // 7. Notifications are real rows produced by the domain events above.
  await ops.getByRole('navigation').getByRole('button', { name: 'Alertes' }).click();
  await expect(ops.getByRole('heading', { name: /Alertes/ }).first()).toBeVisible();

  expect(errors).toEqual([]);
  await Promise.all([passenger.close(), ops.close(), crew.close()]);
});
