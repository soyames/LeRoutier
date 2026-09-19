import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

// The homepage journey search: geography-backed, route-independent. The form
// must exist even with zero routes, zero services and no login.
const APP = 'http://127.0.0.1:4173';
const id = n => `00000000-0000-4000-b000-0000000003${String(n).padStart(2, '0')}1`;
const today = () => new Date().toISOString().slice(0, 10);

async function mockGeography(page, communes) {
  await mockApi(page);
  await page.route('**/api/v1/places?type=commune', r => r.fulfill({ json: { data: communes.map((name, i) => ({ id: id(i), name, kind: 'city', parent_id: null, latitude: 6.4, longitude: 2.4 })) } }));
  await page.route('**/api/v1/places?type=department', r => r.fulfill({ json: { data: [] } }));
}

const CITIES = ['Cotonou', 'Abomey-Calavi', 'Porto-Novo', 'Parakou', 'Bohicon', 'Dassa-Zoumè', 'Savè', 'Natitingou', 'Djougou', 'Ouidah'];

async function choose(page, label, text) {
  const input = page.getByLabel(label);
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

test('the homepage search form renders with zero routes and no /routes dependency', async ({ page }) => {
  await mockGeography(page, CITIES);
  // The form must not depend on the transport inventory: break /routes entirely.
  await page.route('**/api/v1/routes', r => r.abort());
  await page.goto(APP + '/');
  await expect(page.getByRole('heading', { name: 'Où allez-vous ?' })).toBeVisible();
  await expect(page.getByLabel('Départ', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Départ', { exact: true }).locator('option[value="current"]')).toHaveCount(1);
  await expect(page.getByLabel('Destination')).toBeVisible();
  await expect(page.getByLabel('Date')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rechercher un trajet' })).toBeVisible();
  // The old passive copy is gone.
  await expect(page.getByText('Entrez votre destination pour voir les départs disponibles.')).toHaveCount(0);
});

test('destination autocomplete: accented and unaccented typing, keyboard and selection', async ({ page }) => {
  await mockGeography(page, CITIES);
  await page.goto(APP + '/');
  const dest = page.getByLabel('Destination');
  await dest.click();
  await dest.fill('parak');
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole('option', { name: 'Parakou' })).toBeVisible();
  await dest.press('Enter');
  await expect(page.getByRole('button', { name: 'Destination : Parakou. Effacer' })).toBeVisible();
  // Accented spelling finds the same commune.
  await page.getByRole('button', { name: 'Destination : Parakou. Effacer' }).click();
  await dest.fill('Dassa-Zoumè');
  await dest.press('Enter');
  await expect(page.getByRole('button', { name: 'Destination : Dassa-Zoumè. Effacer' })).toBeVisible();
});

test('all 77 communes are searchable, including accent-free spellings', async ({ page }) => {
  // The canonical Benin commune set, in a scrambled-free order close to the API.
  const COMMUNES = [
    'Abomey', 'Abomey-Calavi', 'Adja-Ouèrè', 'Adjarra', 'Adjohoun', 'Aguégués', 'Akpro-Missérété', 'Allada',
    'Aplahoué', 'Athiémé', 'Avrankou', 'Banikoara', 'Bantè', 'Bassila', 'Bembéréké', 'Bohicon', 'Bonou', 'Bopa',
    'Boukoumbé', 'Cobly', 'Comè', 'Copargo', 'Cotonou', 'Covè', 'Dangbo', 'Dassa-Zoumè', 'Djidja', 'Djakotomey',
    'Dogbo', 'Djougou', 'Glazoué', 'Gogounou', 'Grand-Popo', 'Houéyogbé', 'Ifangni', 'Kalalé', 'Kandi', 'Karimama',
    'Kérou', 'Kétou', 'Klouékanmè', 'Kouandé', 'Kpomassè', 'Lalo', 'Lokossa', 'Malanville', 'Matéri', 'N’Dali',
    'Natitingou', 'Nikki', 'Ouaké', 'Ouèssè', 'Ouidah', 'Ouinhi', 'Parakou', 'Pèrèrè', 'Péhunco', 'Pobè',
    'Porto-Novo', 'Sakété', 'Savalou', 'Savè', 'Ségbana', 'Sèmè-Kpodji', 'Sinendé', 'Sô-Ava', 'Tanguiéta',
    'Tchaourou', 'Toffo', 'Tori-Bossito', 'Toucountouna', 'Toviklin', 'Agbangnizoun', 'Za-Kpota', 'Zagnanado', 'Zè',
    'Zogbodomey',
  ];
  expect(COMMUNES).toHaveLength(77);
  await mockGeography(page, COMMUNES);
  await page.goto(APP + '/');
  // A commune at the far end of the list resolves: the whole set is searched.
  await choose(page, 'Destination', 'Zogbodomey');
  await expect(page.getByRole('button', { name: 'Destination : Zogbodomey. Effacer' })).toBeVisible();
  await page.getByRole('button', { name: 'Destination : Zogbodomey. Effacer' }).click();
  // Accent-free typing finds the accented commune.
  await choose(page, 'Destination', 'ketou');
  await expect(page.getByRole('button', { name: 'Destination : Kétou. Effacer' })).toBeVisible();
});

test('manual origin works; the search navigates to /trips with geography params, no login needed', async ({ page }) => {
  await mockGeography(page, CITIES);
  await page.goto(APP + '/');
  await page.getByLabel('Départ', { exact: true }).selectOption('place');
  await choose(page, 'Ville de départ', 'Cotonou');
  await choose(page, 'Destination', 'Parakou');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
  await expect(page).toHaveURL(/\/trips\?/);
  const url = decodeURIComponent(page.url());
  expect(url).toContain(`from=place:${id(0)}`);
  expect(url).toContain(`to=place:${id(3)}`);
  await expect(page.getByText('Recherchez librement.')).toBeVisible();
});

test('swapping exchanges the two selected places', async ({ page }) => {
  await mockGeography(page, CITIES);
  await page.goto(APP + '/');
  await page.getByLabel('Départ', { exact: true }).selectOption('place');
  await choose(page, 'Ville de départ', 'Cotonou');
  await choose(page, 'Destination', 'Parakou');
  await page.getByRole('button', { name: 'Inverser départ et arrivée' }).click();
  await expect(page.getByRole('button', { name: 'Ville de départ : Parakou. Effacer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Destination : Cotonou. Effacer' })).toBeVisible();
});

test('an empty transport catalogue keeps the search UI and states the honest no-service message', async ({ page }) => {
  await mockGeography(page, CITIES);
  await page.route('**/api/v1/journey-plan*', r => r.fulfill({ json: { data: { options: [], originResolved: null, generatedAt: '2026-09-17T00:00:00Z' } } }));
  await page.goto(APP + `/trips?from=place:${id(0)}&to=place:${id(3)}&date=${today()}`);
  await expect(page.getByText('Aucun départ disponible pour cet itinéraire pour le moment.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Modifier la date' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Modifier le départ' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Modifier la destination' })).toBeVisible();
  await expect(page.getByLabel('Destination')).toBeVisible();
  await expect(page.getByText('Entrez votre destination pour voir les départs disponibles.')).toHaveCount(0);
});

test('geolocation denial falls back to manual origin without blocking search', async ({ page }) => {
  await mockGeography(page, CITIES);
  await page.route('**/api/v1/journey-plan*', r => r.fulfill({ json: { data: { options: [], originResolved: null, generatedAt: '2026-09-17T00:00:00Z' } } }));
  await page.goto(APP + `/trips?from=my-location&to=place:${id(3)}&date=${today()}`);
  await page.getByRole('button', { name: 'Utiliser ma position actuelle' }).click();
  await expect(page.getByText('Position non disponible. Choisissez votre ville de départ.')).toBeVisible();
  await expect(page.getByLabel('Départ', { exact: true })).toBeVisible();
});

test('granted position activates the first-mile planner with transient coordinates', async ({ page }) => {
  await mockGeography(page, CITIES);
  const planRequests = [];
  await page.route('**/api/v1/journey-plan*', r => { planRequests.push(r.request().url()); return r.fulfill({ json: { data: { options: [], originResolved: null, generatedAt: '2026-09-17T00:00:00Z' } } }); });
  await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = cb => cb(/** @type {any} */({ coords: { latitude: 6.355, longitude: 2.435 } })); });
  await page.goto(APP + `/trips?from=my-location&to=place:${id(3)}&date=${today()}`);
  await page.getByRole('button', { name: 'Utiliser ma position actuelle' }).click();
  await expect(page.getByText('Aucun départ disponible pour cet itinéraire pour le moment.')).toBeVisible();
  expect(planRequests.some(u => u.includes('lat=6.355') && u.includes('lon=2.435') && u.includes('destinationPlaceId=')), 'the plan uses the transient position').toBeTruthy();
});

test('no Google Maps dependency during the search flow', async ({ page }) => {
  const google = [];
  page.on('request', r => { if (/maps\.googleapis\.com|maps\.google\.com/.test(r.url())) google.push(r.url()); });
  await mockGeography(page, CITIES);
  await page.route('**/api/v1/journey-plan*', r => r.fulfill({ json: { data: { options: [], originResolved: null, generatedAt: '2026-09-17T00:00:00Z' } } }));
  await page.goto(APP + '/');
  await choose(page, 'Destination', 'Parakou');
  await page.getByRole('button', { name: 'Rechercher un trajet' }).click();
  expect(google).toEqual([]);
});
