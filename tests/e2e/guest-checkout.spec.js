import { test, expect } from '@playwright/test';
import { mockApi, TEST_JOURNEY_OPTION } from './api-fixture.js';

// Buying tickets without an account, and keeping them afterwards.
//
// The product rule, end to end in a real browser: SEARCH → RESULTS → CHOOSE →
// CHECKOUT → PAY → TICKETS happens with no account at any point. An account is
// offered once the tickets exist, and only as a way to keep them.
//
// The one authentication wall this suite exists to keep down is the old
// "Continuer vers le paiement → Connectez-vous pour payer" gate. If it ever
// comes back, these tests fail on the sign-in panel appearing mid-purchase.
const APP = 'http://127.0.0.1:4173';

/**
 * The search itself, without navigating to it.
 *
 * Kept separate because a demonstration session lives in memory: a `page.goto`
 * would reload the application and sign the account back out, so a test that has
 * signed in has to reach the search through the app's own navigation.
 */
async function runSearch(page) {
  await page.getByRole('radio', { name: 'Choisir une ville' }).click();
  await page.getByLabel('Ville de départ').click();
  await page.getByLabel('Ville de départ').fill('Cotonou');
  await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').click();
  await page.getByLabel('Destination').fill('Parakou');
  await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
}

async function searchTrips(page) {
  await page.goto(APP + '/trips');
  await runSearch(page);
}

/**
 * The offer used by every case here: a TEST independent driver, 3 seats left.
 *
 * `seatsLeft` widens the coach for the cases that need a bigger party. It is
 * registered before the checkout mounts, because the checkout reads its quote
 * once on arrival.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ seatsLeft?: number }} [options]
 */
async function chooseTestOffer(page, { seatsLeft } = {}) {
  await mockApi(page);
  if (seatsLeft !== undefined) {
    await page.route('**/api/v1/services/*/availability*', r => r.fulfill({ json: { data: {
      serviceId: TEST_JOURNEY_OPTION.serviceId, origin: 0, destination: 3, available: seatsLeft, capacity: seatsLeft,
      fare: TEST_JOURNEY_OPTION.fare, segments: [], stops: [] } } }));
  }
  await searchTrips(page);
  await page.getByRole('button', { name: 'Chauffeurs indépendants' }).click();
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  await expect(page).toHaveURL(/\/checkout/);
}

test('the checkout asks for a name, a phone and a quantity — never an account', async ({ page }) => {
  await chooseTestOffer(page);
  await expect(page.getByText('Votre trajet')).toBeVisible();
  await expect(page.getByText(/Aucun compte n’est nécessaire/)).toBeVisible();
  // Where the sign-in wall used to be.
  await expect(page.getByLabel('Nom et prénom du voyageur principal')).toBeVisible();
  await expect(page.getByLabel('Numéro de téléphone')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Nombre de billets' })).toBeVisible();
  // The phone country defaults to Benin, the platform's own default, and offers
  // the neighbours a traveller might actually be calling from.
  await expect(page.getByLabel(/Pays de l’indicatif/)).toHaveValue('BJ');
  await expect(page.getByLabel(/Pays de l’indicatif/).locator('option[value="TG"]')).toHaveCount(1);
  await expect(page.getByText('Bienvenue sur LeRoutier')).toHaveCount(0);
});

test('the fare per passenger and the total for the party are both shown before paying', async ({ page }) => {
  await chooseTestOffer(page);
  await expect(page.getByText('7 500 FCFA par voyageur')).toBeVisible();
  await expect(page.getByText('7 500 FCFA').last()).toBeVisible();
  await page.getByRole('button', { name: '3 billets' }).click();
  await expect(page.getByText('22 500 FCFA')).toBeVisible();
  await expect(page.getByText('× 3 voyageurs')).toBeVisible();
  await page.getByRole('button', { name: '1 billet' }).click();
  await expect(page.getByText('× 3 voyageurs')).toHaveCount(0);
});

test('a quantity beyond what the coach has is not offered', async ({ page }) => {
  await chooseTestOffer(page);
  // Three seats on this offer: the chips above three are disabled, and the
  // number field refuses anything larger.
  await expect(page.getByRole('button', { name: '3 billets' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '2 billets' })).toBeEnabled();
  // The custom field clamps to the seats that exist rather than accepting a
  // quantity that would be refused after payment had been attempted.
  await page.getByLabel('Autre nombre de billets').fill('9');
  await expect(page.getByLabel('Autre nombre de billets')).toHaveValue('3');
});

test('ten tickets is the ceiling, and a party of ten buys and boards like any other', async ({ page }) => {
  await chooseTestOffer(page, { seatsLeft: 12 });
  await page.getByLabel('Nom et prénom du voyageur principal').fill('Awa Sossou');
  await page.getByLabel('Numéro de téléphone').fill('97000042');
  // Ten is the most one purchase covers, and the quick chips stop at three: the
  // rest is a number, clamped at the ceiling rather than refused after the fact.
  await page.getByLabel('Autre nombre de billets').fill('10');
  await expect(page.getByText('75 000 FCFA')).toBeVisible();
  await page.getByLabel('Autre nombre de billets').fill('11');
  await expect(page.getByLabel('Autre nombre de billets')).toHaveValue('10');
  await page.getByRole('button', { name: /Payer 10 billets/ }).click();
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Afficher mon billet' })).toHaveCount(10);
});

test('the payment button stays closed until there is somebody to contact', async ({ page }) => {
  await chooseTestOffer(page);
  const payButton = page.getByRole('button', { name: /Continuer vers le paiement|Payer/ });
  await expect(payButton).toBeDisabled();
  await page.getByLabel('Nom et prénom du voyageur principal').fill('Awa Sossou');
  await expect(payButton).toBeDisabled();
  await page.getByLabel('Numéro de téléphone').fill('97000042');
  await expect(payButton).toBeEnabled();
});

test('a guest buys two tickets and lands on them, still signed out', async ({ page }) => {
  await chooseTestOffer(page);
  await page.getByLabel('Nom et prénom du voyageur principal').fill('Awa Sossou');
  await page.getByLabel('Numéro de téléphone').fill('97000042');
  await page.getByRole('button', { name: '2 billets' }).click();
  await expect(page.getByText('15 000 FCFA')).toBeVisible();
  await page.getByRole('button', { name: /Payer 2 billets/ }).click();
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });
  // The party arrived, on a device holding no account at all: two ticket cards,
  // each openable. The sign-in panel is on this page too — as an offer beside
  // the tickets, which is the whole point — so what is asserted is that the
  // tickets are HERE and usable, not that no way to sign in is visible.
  await expect(page.getByText('Cotonou → Parakou').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Afficher mon billet' })).toHaveCount(2);
  await expect(page.getByText('Aucun voyage pour le moment')).toHaveCount(0);
  await expect(page.getByText('Connectez-vous', { exact: true })).toHaveCount(0);
});

test('each traveller of a party gets their own ticket', async ({ page }) => {
  await chooseTestOffer(page);
  await page.getByLabel('Nom et prénom du voyageur principal').fill('Awa Sossou');
  await page.getByLabel('Numéro de téléphone').fill('97000042');
  await page.getByRole('button', { name: '3 billets' }).click();
  await page.getByRole('button', { name: /Payer 3 billets/ }).click();
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });
  const tickets = page.getByRole('button', { name: 'Afficher mon billet' });
  await expect(tickets).toHaveCount(3, { timeout: 15000 });
  await tickets.first().click();
  await expect(page.getByText(/Siège/).first()).toBeVisible();
});

test('keeping the tickets is offered, and only after there is something to keep', async ({ page }) => {
  await chooseTestOffer(page);
  // Nothing bought yet: no offer, because there is nothing to keep.
  await expect(page.getByText('Gardez vos billets')).toHaveCount(0);
  await page.getByLabel('Nom et prénom du voyageur principal').fill('Awa Sossou');
  await page.getByLabel('Numéro de téléphone').fill('97000042');
  await page.getByRole('button', { name: /Continuer vers le paiement/ }).click();
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });
  // The offer appears beside the tickets, and the tickets are usable without it.
  await expect(page.getByText('Gardez vos billets')).toBeVisible();
  await expect(page.getByText(/facultatif/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Afficher mon billet' })).toBeVisible();
});

// The published sign-in configuration, as production serves it: e-mail and
// password available. Without it the panel cannot render a registration form
// at all, and a test asserting the form's absence would pass for the wrong
// reason — it would be measuring a missing feature rather than a closed door.
const CAN_SIGN_IN = { demoLogin: true, firebase: { apiKey: 'browser-test-api-key',
  authDomain: 'example.firebaseapp.com', projectId: 'example-project', appId: '1:1:web:test', providers: [] } };

test('before anything is bought, the tickets screen sells a ticket instead of an account', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: CAN_SIGN_IN } }));
  await page.goto(APP + '/tickets');

  // A traveller's account is opened by a first ticket, so there is nothing to
  // offer one for yet — and the screen says what to do instead rather than
  // showing a form that would be refused.
  await expect(page.getByRole('button', { name: 'Pas encore de compte ? Créer un compte' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Créer un compte' })).toHaveCount(0);
  await expect(page.getByText('Aucun billet pour le moment')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rechercher un trajet' })).toBeVisible();
  // Signing IN is still here: a passenger who already has an account has to be
  // able to open the tickets in it.
  await expect(page.getByLabel('Adresse e-mail')).toBeVisible();
  await expect(page.getByText(/Un compte voyageur s’ouvre avec un premier billet/)).toBeVisible();
  // The professional door is named, so nobody working in transport is stranded
  // behind a rule aimed at travellers.
  await expect(page.getByRole('link', { name: 'Créez votre compte professionnel' })).toBeVisible();
});

test('after a ticket is bought, keeping the account is offered and the ticket never waits for it', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/auth/config', r => r.fulfill({ json: { data: CAN_SIGN_IN } }));
  await searchTrips(page);
  await page.getByRole('button', { name: 'Chauffeurs indépendants' }).click();
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  await expect(page).toHaveURL(/\/checkout/);
  await page.getByLabel('Nom et prénom du voyageur principal').fill('Awa Sossou');
  await page.getByLabel('Numéro de téléphone').fill('97000042');
  await page.getByRole('button', { name: /Continuer vers le paiement/ }).click();
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });

  // The purchase exists, so the offer exists — beside the tickets, never in
  // front of them. The card leads, because it is the purchase that makes the
  // offer possible and what is being asserted is the order between them.
  await expect(page.getByText('Gardez vos billets')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Afficher mon billet' })).toBeVisible();
  // The offer is read from the bookings, which arrive after the purchase does,
  // so this waits for them rather than for the paint.
  await expect(page.getByRole('button', { name: 'Pas encore de compte ? Créer un compte' }))
    .toBeVisible({ timeout: 15_000 });
  // Following the journey does not need the account either.
  await page.goto(APP + '/tracking');
  await expect(page.getByLabel('Référence du billet')).toBeVisible();
});

test('a signed-in driver buys a personal ticket as a guest, and can still open it', async ({ page }) => {
  await mockApi(page);
  // A DRIVER is a service provider, not a passenger. They are signed in, and
  // they want a ticket for themselves.
  await page.goto(APP + '/account');
  await page.getByRole('button', { name: 'Développement : driver' }).click();
  await expect(page.getByText('Compte Démo').first()).toBeVisible();

  await page.getByRole('button', { name: 'Accueil LeRoutier' }).click();
  await runSearch(page);
  await page.getByRole('button', { name: 'Chauffeurs indépendants' }).click();
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  await expect(page).toHaveURL(/\/checkout/);
  // The checkout asks a provider for a name and a phone exactly as it asks a
  // visitor: a provider account is not a passenger account, so it does not buy
  // as one — and it is not refused, either, or sent to buy a ticket in order to
  // be a provider.
  await expect(page.getByText('Vos coordonnées')).toBeVisible();
  await expect(page.getByText(/Complétez votre profil|Bienvenue sur LeRoutier/)).toHaveCount(0);
  await page.getByLabel('Nom et prénom du voyageur principal').fill('Chauffeur Test');
  await page.getByLabel('Numéro de téléphone').fill('97110022');
  await page.getByRole('button', { name: /Continuer vers le paiement/ }).click();
  await expect(page).toHaveURL(/\/tickets\//, { timeout: 15000 });

  // The ticket is theirs to open. It is read through the guest link it was
  // bought with — a driver account is refused by the passenger endpoints, and
  // being shown a 403 on a ticket they paid for is the failure this prevents.
  await expect(page.getByRole('button', { name: 'Afficher mon billet' })).toBeVisible();
  // And it is not offered up to their provider account, because a ticket is a
  // passenger identity and claiming must never be how an operator account gets
  // one.
  await expect(page.getByRole('button', { name: 'Rattacher mes billets' })).toHaveCount(0);
  await expect(page.getByText('Ces billets restent liés à cet appareil')).toBeVisible();
});

test('a signed-in passenger still buys as themselves, and is asked for no contact details', async ({ page }) => {
  await mockApi(page);
  // Sign in FIRST, through the development path — a returning account, which
  // the product promises keeps working exactly as it did.
  await page.goto(APP + '/account');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  await expect(page.getByText('Compte Démo').first()).toBeVisible();
  // Then buy, and be asked for nothing. Through the app's own navigation — a
  // reload would end the demonstration session this test just established — and
  // from the home page, because on a phone the nav links are behind the drawer.
  await page.getByRole('button', { name: 'Accueil LeRoutier' }).click();
  await runSearch(page);
  await page.getByRole('button', { name: 'Chauffeurs indépendants' }).click();
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  await expect(page).toHaveURL(/\/checkout/);
  await expect(page.getByText('Vos coordonnées')).toHaveCount(0);
  await expect(page.getByLabel('Nom et prénom du voyageur principal')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Continuer vers le paiement/ })).toBeEnabled();
});
