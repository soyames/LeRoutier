import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// What the public screens make a person think they can do.
//
// A heuristic walkthrough of production found four screens promising something
// the next step did not support: a search that said one seat per booking when a
// booking carries a party, a parcel page that asked for an account before it
// said what sending involves, an onboarding screen that dropped the role the
// reader had already chosen, and an origin picker whose second option existed
// only for people who thought to open a control that looked answered.
//
// Each test below holds one of those to what the interface now claims.
const APP = 'http://127.0.0.1:4173';

// The published sign-in configuration as production serves it. Without it the
// panel cannot render a registration form at all, so "registration is open"
// would be measured against a fixture that has no registration to open.
const CAN_SIGN_IN = { demoLogin: true, firebase: { apiKey: 'browser-test-api-key',
  authDomain: 'example.firebaseapp.com', projectId: 'example-project', appId: '1:1:web:test', providers: [] } };

test('the search says a party can book together, on the home page and on the search page', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/');
  // It read "Une seule place par réservation", which told a family travelling
  // together that the app could not sell them seats. A purchase has carried up
  // to ten people since group bookings shipped.
  await expect(page.getByText(/Réservez jusqu’à 10 places en une seule fois/)).toBeVisible();
  await expect(page.getByText(/Une seule place par réservation/)).toHaveCount(0);

  await page.goto(APP + '/trips');
  await expect(page.getByText(/Jusqu’à 10 places par réservation/)).toBeVisible();
  await expect(page.getByText(/1 place par réservation/)).toHaveCount(0);
});

test('a party sees the whole total before paying, not a per-seat price', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/trips');
  await page.getByRole('radio', { name: 'Choisir une ville' }).click();
  await page.getByLabel('Ville de départ').click();
  await page.getByLabel('Ville de départ').fill('Cotonou');
  await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').click();
  await page.getByLabel('Destination').fill('Parakou');
  await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
  await page.getByRole('button', { name: 'Chauffeurs indépendants' }).click();
  await page.getByRole('button', { name: 'Choisir' }).first().click();

  // Three travellers: the fare per passenger AND what the party pays.
  await page.getByRole('button', { name: '3 billets' }).click();
  await expect(page.getByText('7 500 FCFA par voyageur')).toBeVisible();
  await expect(page.getByText('22 500 FCFA')).toBeVisible();
  await expect(page.getByText('× 3 voyageurs')).toBeVisible();
});

test('sending a parcel leads with the job, not with an account form', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/parcels');

  // The shape of the job is on screen first: three steps, named.
  const steps = page.locator('.steps');
  await expect(steps).toContainText('Trajet');
  await expect(steps).toContainText('Colis & prix');
  // The account requirement is stated beside the action it applies to, and the
  // thing that is public about parcels is said out loud, so nobody assumes the
  // tracking they came for is behind the same wall.
  await expect(page.getByText(/Créer un envoi demande un compte/)).toBeVisible();
  await expect(page.getByText(/Le suivi d’un colis, lui, reste public/)).toBeVisible();
  // And the requirement is inside the task surface rather than in a panel above
  // it: the first thing on the page is the hero and the send/suivre choice.
  const hero = await page.locator('.parcel-hero').boundingBox();
  const task = await steps.boundingBox();
  expect(task.y).toBeGreaterThan(hero.y);
});

test('parcel tracking stays public, with nothing asked for', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP + '/parcels/track');
  // The one screen about parcels that has always been open, and stays open.
  await expect(page.getByLabel('Numéro de suivi')).toBeVisible();
  await expect(page.getByText('Bienvenue sur LeRoutier')).toHaveCount(0);
  await expect(page.getByText('Connexion requise')).toHaveCount(0);
});

test('a company that pressed “Enregistrer ma compagnie” arrives at the company dossier', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: CAN_SIGN_IN } }));
  await page.goto(APP + '/professionnel');
  await page.getByRole('button', { name: 'Enregistrer ma compagnie' }).click();
  await expect(page).toHaveURL(/\/onboarding\?profil=company/);
  // The role is not asked for twice: the screen already knows, and says so.
  await expect(page.getByText('Dossier de compagnie de transport')).toBeVisible();
  // Registration is open on this screen for every provider role — a driver or a
  // company is not buying a ticket and is never asked for one.
  await expect(page.getByRole('button', { name: 'Pas encore de compte ? Créer un compte' })).toBeVisible();
});

test('an independent driver arrives at the driver dossier', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: CAN_SIGN_IN } }));
  await page.goto(APP + '/professionnel');
  await page.getByRole('button', { name: 'Commencer mon dossier' }).click();
  await expect(page).toHaveURL(/\/onboarding\?profil=independent/);
  await expect(page.getByText('Dossier de chauffeur indépendant')).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('both ways to say where you are starting from are on screen', async ({ page }) => {
    await mockApi(page);
    await page.goto(APP + '/trips');
    // Not one label over a hidden list: a <select> shows only the answer it
    // already holds, so "choose a city" existed for exactly the people who
    // thought to tap a control that looked answered.
    const current = page.getByRole('radio', { name: 'Ma position' });
    const byCity = page.getByRole('radio', { name: 'Choisir une ville' });
    await expect(current).toBeVisible();
    await expect(byCity).toBeVisible();
    await expect(current).toHaveAttribute('aria-checked', 'true');
    await expect(byCity).toHaveAttribute('aria-checked', 'false');

    // Choosing a city is one tap, and the city field appears with it.
    await byCity.click();
    await expect(byCity).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Ville de départ')).toBeVisible();
    // Both fit the column without being cut off.
    for (const name of ['Ma position', 'Choisir une ville']) {
      const box = await page.getByRole('radio', { name }).boundingBox();
      expect(box.width, `${name} is fully drawn`).toBeGreaterThan(60);
    }
  });
});
