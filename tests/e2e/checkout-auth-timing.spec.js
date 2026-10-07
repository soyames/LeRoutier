import { test, expect } from '@playwright/test';
import { mockApi, TEST_JOURNEY_OPTION } from './api-fixture.js';

// The product rule: the WHOLE funnel — SEARCH → RESULTS → COMPARE → VIEW →
// SELECT → CHECKOUT → PAY — happens anonymously.
//
// There used to be exactly one authentication wall, at "Continuer vers le
// paiement": a visitor could review a trip but had to create an account before
// paying for it. That is gone, and the account is now offered afterwards as a
// way to keep the tickets. The tests below are the fence around that: if the
// wall ever comes back, the funnel stops being anonymous and these fail.
const APP = 'http://127.0.0.1:4173';
const GOOGLE_MAP_HOSTS = new Set(['maps.googleapis.com', 'maps.google.com']);

async function searchTrips(page, origin = 'Cotonou', destination = 'Parakou') {
  await page.goto(APP + '/trips');
  await page.getByLabel('Départ', { exact: true }).selectOption('place');
  await page.getByLabel('Ville de départ').click();
  await page.getByLabel('Ville de départ').fill(origin);
  await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').click();
  await page.getByLabel('Destination').fill(destination);
  await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
}

test('results, fares, detail and selection need no authentication at any point', async ({ page }) => {
  await mockApi(page);
  await searchTrips(page);
  // Two comparable offers: a company and an independent TEST driver.
  await expect(page.getByText('2 trajets disponibles')).toBeVisible();
  await expect(page.getByText('Opérateur démo')).toBeVisible();
  await expect(page.getByText('TEST Chauffeur 01')).toBeVisible();
  await expect(page.getByText('Toyota Hiace')).toBeVisible();
  await expect(page.getByText('Autocar')).toBeVisible();
  await expect(page.getByText('7 500 FCFA').first()).toBeVisible();
  // The TEST offer wears its badge; the banner states the mode plainly.
  await expect(page.getByText('TEST', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Mode test/)).toBeVisible();
  // No auth UI anywhere on the results.
  await expect(page.getByText('Bienvenue sur LeRoutier')).toHaveCount(0);

  // Offer detail opens anonymously with the full timeline and the map.
  await page.getByRole('button', { name: 'Voir le trajet' }).first().click();
  await expect(page.getByText('Départ LeRoutier')).toBeVisible();
  await expect(page.getByText(/Arrivée Parakou/)).toBeVisible();
  await expect(page.getByRole('region', { name: /Carte du trajet complet/ })).toBeVisible();
  await expect(page.getByText('Bienvenue sur LeRoutier')).toHaveCount(0);
  await page.getByRole('button', { name: 'Fermer les détails' }).click();
});

test('sorting and filters are factual and stay anonymous', async ({ page }) => {
  await mockApi(page);
  await searchTrips(page);
  await page.getByLabel('Trier les trajets').selectOption('cheapest');
  await page.getByLabel('Trier les trajets').selectOption('earliest');
  await page.getByRole('button', { name: 'Chauffeurs indépendants' }).click();
  await expect(page.getByText('1 trajet disponible')).toBeVisible();
  await expect(page.getByText('Opérateur démo')).toHaveCount(0);
  await expect(page.getByText('TEST Chauffeur 01')).toBeVisible();
  await page.getByRole('button', { name: 'Tout' }).click();
  await expect(page.getByText('2 trajets disponibles')).toBeVisible();
});

test('choosing an offer opens the checkout anonymously, with no payment gate behind it', async ({ page }) => {
  await mockApi(page);
  await searchTrips(page);
  await page.getByRole('button', { name: 'Chauffeurs indépendants' }).click();
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  await expect(page).toHaveURL(/\/checkout/);
  // The full journey and the final fare are reviewable without an account.
  await expect(page.getByText('Votre trajet')).toBeVisible();
  await expect(page.getByText('Transport LeRoutier · TEST Chauffeur 01')).toBeVisible();
  await expect(page.getByText('7 500 FCFA').first()).toBeVisible();
  await expect(page.getByText(/Aucun compte n’est nécessaire/)).toBeVisible();
  await expect(page.getByText('Bienvenue sur LeRoutier')).toHaveCount(0);

  // Where the wall used to be: the details a booking actually needs, and
  // nothing about an account.
  await expect(page.getByLabel('Nom et prénom du voyageur principal')).toBeVisible();
  await expect(page.getByText('Vos coordonnées')).toBeVisible();
  await expect(page.getByText('Bienvenue sur LeRoutier')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connexion de développement' })).toHaveCount(0);
});

test('the whole funnel to the tickets completes with no authentication at any point', async ({ page }) => {
  await mockApi(page);
  // Checked at every step rather than only at the end, because the wall this
  // guards against used to sit in the middle of the funnel: a visitor could
  // reach the checkout and was stopped only at "Continuer vers le paiement".
  const stillAnonymous = () => expect(page.getByText('Bienvenue sur LeRoutier')).toHaveCount(0);
  await searchTrips(page);
  await stillAnonymous();
  await page.getByRole('button', { name: 'Chauffeurs indépendants' }).click();
  await stillAnonymous();
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  await stillAnonymous();
  await page.getByLabel('Nom et prénom du voyageur principal').fill('Awa Sossou');
  await page.getByLabel('Numéro de téléphone').fill('97000042');
  await stillAnonymous();
  await page.getByRole('button', { name: /Continuer vers le paiement/ }).click();
  // Paid, and on the tickets. The account offer lives on THAT screen, beside
  // the tickets rather than in front of them, which is the difference the whole
  // change is about.
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Afficher mon billet' })).toBeVisible();
});

test('a sold-out offer is visible with an honest badge and no bookable action', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/journey-plan*', r => r.fulfill({ json: { data: {
    options: [{ ...TEST_JOURNEY_OPTION, available: 0, feasible: false }],
    originResolved: null, generatedAt: '2026-09-17T00:00:00Z' } } }));
  await searchTrips(page);
  await expect(page.getByText('Complet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choisir' }).first()).toBeDisabled();
  // Even the sold-out state never asks for an account.
  await expect(page.getByText('Bienvenue sur LeRoutier')).toHaveCount(0);
});

test('the map renders with Leaflet and never touches Google Maps', async ({ page }) => {
  const google = [];
  page.on('request', r => {
    let hostname = '';
    try { hostname = new URL(r.url()).hostname; } catch { return; }
    if (GOOGLE_MAP_HOSTS.has(hostname)) google.push(r.url());
  });
  await mockApi(page);
  await searchTrips(page);
  const mapToggle = page.getByRole('button', { name: /Carte/ });
  if (await mapToggle.isVisible()) await mapToggle.click();
  await expect(page.locator('.leaflet-container').first()).toBeVisible();
  // The map is supplemental: every journey fact is also readable text.
  await expect(page.getByText('Opérateur démo')).toBeVisible();
  expect(google).toEqual([]);
});
