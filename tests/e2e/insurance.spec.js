// The insurance add-on, as a passenger actually meets it.
//
// The assertions here are mostly about what the product REFUSES to say. A
// passenger who has ticked a box is not insured, and the screen has to be
// honest about that at every step, including the step where it would be much
// easier to show a green tick.
import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

const APP = 'http://127.0.0.1:4173';

const OFFER = {
  productId: '00000000-0000-4000-c000-000000000001',
  code: 'TRIP-ACC', name: 'Protection voyage',
  summary: 'Frais médicaux à la suite d’un accident pendant le trajet.',
  scope: 'trip', coverAmountMinor: 500000, premiumMinor: 500, premiumMode: 'flat',
  currency: 'XOF', exclusions: 'Effets personnels, retards.', termsUrl: null,
  partner: { name: 'Atlantique Assurances', kind: 'insurer' },
  paidTo: 'partner', consentVersion: 'lr-insurance-2026-09',
};

const BOOKING = '00000000-0000-4000-8000-000000000050';

const withOffers = (page, offers) =>
  page.route('**/api/v1/insurance/offers*', r => r.fulfill({ json: { data: offers } }));
const withPolicy = (page, policy) =>
  page.route('**/api/v1/bookings/*/insurance', r => r.fulfill({ json: { data: policy } }));

/** Reach the checkout the way a passenger does: search, then choose an offer. */
async function toCheckout(page) {
  await page.goto(APP + '/trips');
  await page.getByLabel('Départ', { exact: true }).selectOption('place');
  await page.getByLabel('Ville de départ').click();
  await page.getByLabel('Ville de départ').fill('Cotonou');
  await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').click();
  await page.getByLabel('Destination').fill('Parakou');
  await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
  // The first option is the real one; the TEST offer never shows an add-on.
  await page.getByRole('button', { name: 'Choisir' }).first().click();
  await expect(page).toHaveURL(/\/checkout/);
}

/** One confirmed booking, so the ticket list has a card to hang a policy on. */
const withBooking = page => page.route('**/api/v1/me/bookings', r => r.fulfill({ json: { data: [{
  id: BOOKING, route_name: 'DEMO Cotonou → Parakou', status: 'confirmed',
  departure_at: '2026-09-16T08:00:00Z', seat_number: 3, amount_minor: 2500,
  departure_city: 'Cotonou', departure_point_name: 'Godomey – Carrefour', departure_point_landmark: null,
  departure_point_latitude: 6.37, departure_point_longitude: 2.39,
  arrival_city: 'Parakou', arrival_point_name: 'Gare de Parakou', arrival_point_landmark: null,
  arrival_point_latitude: null, arrival_point_longitude: null,
  service_id: '00000000-0000-4000-8000-000000000030',
}] } }));

async function toTickets(page, policy) {
  await withBooking(page);
  await withPolicy(page, policy);
  await page.goto(APP + '/tickets');
  await page.getByRole('button', { name: 'Connexion de développement' }).click();
  await expect(page.getByRole('heading', { name: 'Cotonou → Parakou', exact: true })).toBeVisible();
}

test('the add-on is offered beside the fare, never preselected', async ({ page }) => {
  await mockApi(page);
  await withOffers(page, [OFFER]);
  await toCheckout(page);

  const option = page.getByRole('radio', { name: /Protection voyage/ });
  await expect(option).toBeVisible();
  await expect(option).toHaveAttribute('aria-checked', 'false');
  // The price, the insurer and the exclusions are all readable before choosing.
  await expect(page.getByText('Atlantique Assurances').first()).toBeVisible();
  await expect(page.getByText(/Effets personnels, retards/)).toBeVisible();
  // And it is plainly LeRoutier's partner's product, not LeRoutier's.
  await expect(page.getByText(/Proposé par un assureur partenaire, pas par LeRoutier/)).toBeVisible();
});

test('choosing it states who receives the data and that the premium is not ours', async ({ page }) => {
  await mockApi(page);
  await withOffers(page, [OFFER]);
  await toCheckout(page);

  await page.getByRole('radio', { name: /Protection voyage/ }).click();
  const consent = page.getByText(/En confirmant, vous demandez cette garantie/);
  await expect(consent).toBeVisible();
  // A consent to a transfer has to name the recipient and the fields.
  await expect(consent).toContainText('Atlantique Assurances');
  await expect(consent).toContainText('votre nom');
  await expect(consent).toContainText('votre téléphone');
  await expect(consent).toContainText(/n’est pas incluse dans le montant payé à LeRoutier/);
  // Declining is one action away and costs nothing.
  await page.getByRole('button', { name: 'Continuer sans assurance' }).click();
  await expect(page.getByRole('radio', { name: /Protection voyage/ })).toHaveAttribute('aria-checked', 'false');
});

test('with no active partner the checkout is exactly as it was', async ({ page }) => {
  await mockApi(page);
  await withOffers(page, []);
  await toCheckout(page);

  await expect(page.getByRole('button', { name: 'Continuer vers le paiement' })).toBeVisible();
  // Not an empty state, not a "bientôt disponible". Advertising cover LeRoutier
  // cannot sell is the same lie in a smaller font.
  await expect(page.getByText(/assurance/i)).toHaveCount(0);
});

test('a requested policy says plainly that nobody is covered yet', async ({ page }) => {
  await mockApi(page);
  await toTickets(page, {
    id: 'p1', status: 'requested', scope: 'trip', productName: 'Protection voyage',
    coverAmountMinor: 500000, premiumMinor: 500, currency: 'XOF', premiumCollectedBy: 'partner',
    partnerReference: null, declinedReason: null, requestedAt: new Date().toISOString(),
    partner: { name: 'Atlantique Assurances', claimsPhone: '+22921310000', claimsEmail: null, claimsUrl: null },
  });

  await expect(page.getByText('Demande transmise')).toBeVisible();
  await expect(page.getByText(/Vous n’êtes pas encore couvert/)).toBeVisible();
  // No reference exists yet, so none is shown — not even a placeholder that
  // could be mistaken for one.
  await expect(page.getByText('Référence de police')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Annuler cette demande' })).toBeVisible();
});

test('an issued policy shows its reference and a reachable claims route', async ({ page }) => {
  await mockApi(page);
  await toTickets(page, {
    id: 'p2', status: 'active', scope: 'trip', productName: 'Protection voyage',
    coverAmountMinor: 500000, premiumMinor: 500, currency: 'XOF', premiumCollectedBy: 'partner',
    partnerReference: 'POL-2026-77', declinedReason: null, requestedAt: new Date().toISOString(),
    partner: { name: 'Atlantique Assurances', claimsPhone: '+22921310000', claimsEmail: null, claimsUrl: null },
  });

  await expect(page.getByText('Garantie active')).toBeVisible();
  await expect(page.getByText('POL-2026-77')).toBeVisible();
  await expect(page.getByRole('link', { name: '+22921310000' })).toHaveAttribute('href', 'tel:+22921310000');
  // LeRoutier does not instruct claims and says so rather than leaving the
  // passenger to discover it when they need help.
  await expect(page.getByText(/LeRoutier n’instruit pas les sinistres/)).toBeVisible();
  // An issued contract cannot be torn up from here.
  await expect(page.getByRole('button', { name: 'Annuler cette demande' })).toHaveCount(0);
});

test('a refusal is stated with its reason and clears the passenger of consequences', async ({ page }) => {
  await mockApi(page);
  await toTickets(page, {
    id: 'p3', status: 'declined', scope: 'trip', productName: 'Protection voyage',
    coverAmountMinor: 500000, premiumMinor: 500, currency: 'XOF', premiumCollectedBy: 'partner',
    partnerReference: null, declinedReason: 'Trajet hors zone couverte.', requestedAt: new Date().toISOString(),
    partner: { name: 'Atlantique Assurances', claimsPhone: '+22921310000', claimsEmail: null, claimsUrl: null },
  });

  await expect(page.getByText('Garantie refusée')).toBeVisible();
  await expect(page.getByText('Trajet hors zone couverte.')).toBeVisible();
  await expect(page.getByText(/Votre trajet et votre paiement ne changent pas/)).toBeVisible();
  // A refused policy offers no claims route, because there is nothing to claim on.
  await expect(page.getByText(/En cas de sinistre/)).toHaveCount(0);
});

test('the insurance console is refused to a platform identity without the grant', async ({ page }) => {
  await mockApi(page);
  // A platform identity holding everything EXCEPT insurance. Both the demo
  // sign-in and /me are overridden: the fixture's `ops` role carries an
  // operator_id, which would make this an operator's own account rather than
  // LeRoutier staff, and the two see completely different consoles.
  const staff = {
    id: '00000000-0000-4000-8000-000000000002', role: 'ops', display_name: 'Staff', operator_id: null,
    platform_capabilities: ['verification', 'users', 'finance', 'system'],
  };
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session-ops', user: staff } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: staff } }));
  // Sign in first: an unauthenticated deep link into /ops falls back to the
  // landing page, so navigating straight there would prove nothing.
  await page.goto(APP + '/ops');
  await page.getByRole('button', { name: 'Développement : ops' }).click();
  // The role strip, not the header subtitle: the subtitle is desktop-only and
  // asserting on it passes at 1280px and fails on a phone.
  await expect(page.getByText('Exploitation plateforme').first()).toBeVisible();

  // The destination is filtered out of the navigation this identity is given,
  // while the ones it does hold are offered.
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Assurances' })).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Finances' })).toBeVisible();
});

test('the insurance console is offered to an identity that holds the grant', async ({ page }) => {
  await mockApi(page);
  const staff = {
    id: '00000000-0000-4000-8000-000000000002', role: 'ops', display_name: 'Staff', operator_id: null,
    platform_capabilities: ['insurance'],
  };
  await page.route('**/api/v1/auth/demo', r => r.fulfill({ json: { data: { token: 'fixture-session-ops', user: staff } } }));
  await page.route('**/api/v1/me', r => r.fulfill({ json: { data: staff } }));
  await page.route('**/api/v1/ops/insurance/partners', r => r.fulfill({ json: { data: [] } }));
  await page.route('**/api/v1/ops/insurance/policies*', r => r.fulfill({ json: { data: [] } }));
  await page.goto(APP + '/ops');
  await page.getByRole('button', { name: 'Développement : ops' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Assurances' }).click();

  await expect(page.getByRole('heading', { name: 'Assurances & partenaires' })).toBeVisible();
  // The screen leads with what LeRoutier is and is not, because everything
  // downstream of that sentence depends on the reader believing it.
  await expect(page.getByText('LeRoutier ne porte aucun risque.')).toBeVisible();
  await expect(page.getByText(/ne devient « émise » qu’avec une référence de police/)).toBeVisible();
  await expect(page.getByText('Aucune demande')).toBeVisible();
});
