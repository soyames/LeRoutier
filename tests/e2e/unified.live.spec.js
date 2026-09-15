import { test, expect } from '@playwright/test';

// The unified PWA against the real API and a disposable Neon schema. No route
// is mocked here: every screen below is rendering data that actually came out
// of PostgreSQL through /api/v1.
const APP = 'http://127.0.0.1:4176';
const signIn = (page, role) => page.getByRole('button', { name: 'Développement : ' + role }).click();

test('the unified PWA carries a real database-backed journey across workspaces', async ({ browser }) => {
  const passenger = await browser.newPage(), ops = await browser.newPage(), crew = await browser.newPage();
  const errors = [];
  for (const page of [passenger, ops, crew]) page.on('pageerror', () => errors.push('browser error'));

  // 1. One public entry point, anonymous, backed by real data.
  await passenger.goto(APP + '/');
  await expect(passenger.getByRole('button', { name: /Rechercher un trajet/ })).toBeVisible();
  await passenger.getByRole('button', { name: /Rechercher un trajet/ }).click();
  await expect(passenger).toHaveURL(/\/trips$/);
  // First real round trip to Neon after mount: allow for the query, not for a
  // flaky retry loop.
  await expect(passenger.getByText('DEMO - Corridor Benin')).toBeVisible({ timeout: 20000 });
  await expect(passenger.getByText('DEMO-BUS-01').first()).toBeVisible();
  // Anonymous search works; cash is never offered to a passenger.
  await expect(passenger.getByRole('button', { name: 'Se connecter pour réserver' }).first()).toBeEnabled();
  await expect(passenger.getByText(/espèces/i)).toHaveCount(0);

  // 2. Login happens at the action, and books against the real domain.
  await signIn(passenger, 'passenger');
  await passenger.getByLabel('Arrivée').selectOption({ label: 'Bohicon · Zakpo (démo)' });
  await passenger.getByRole('button', { name: 'Réserver une place' }).click();
  await expect(passenger).toHaveURL(/\/tickets$/);
  await expect(passenger.getByText('Option en attente de paiement')).toBeVisible();

  // 3. The Ops workspace, same PWA, records the counter cash payment.
  await ops.goto(APP + '/ops/payments');
  await signIn(ops, 'ops');
  await expect(ops.getByLabel('Référence du reçu')).toBeVisible();
  await ops.getByLabel('Référence du reçu').fill('DEMO-UNIFIED-RECEIPT');
  await ops.getByRole('button', { name: 'Enregistrer le paiement' }).first().click();
  await expect(ops.getByText('Action enregistrée.')).toBeVisible({ timeout: 15000 });

  // 4. Passenger confirms, issues a real ticket, and sees the end-to-end
  //    journey: exact boarding point plus the optional first-mile handoff.
  await passenger.getByRole('button', { name: 'Confirmer la réservation' }).click();
  await expect(passenger.getByText('Confirmé', { exact: true })).toBeVisible();
  await passenger.getByRole('button', { name: 'Obtenir mon billet (QR)' }).click();
  await expect(passenger.getByText(/LR-[0-9A-F]{4}-[0-9A-F]{4}/)).toBeVisible();

  // 5. The Ops workspace and the crew workspace live in the same product.
  await crew.goto(APP + '/work/today');
  await signIn(crew, 'driver');
  await expect(crew.getByText('DEMO-BUS-01').first()).toBeVisible();
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
  await expect(crew.getByText('DEMO - Corridor Benin')).toBeVisible();

  // 7. Notifications are real rows produced by the domain events above.
  await ops.getByRole('navigation').getByRole('button', { name: 'Alertes' }).click();
  await expect(ops.getByRole('heading', { name: /Alertes/ }).first()).toBeVisible();

  expect(errors).toEqual([]);
  await Promise.all([passenger.close(), ops.close(), crew.close()]);
});
