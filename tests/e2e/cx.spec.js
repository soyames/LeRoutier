import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

const me=role=>Object.assign({id:'00000000-0000-4000-8000-000000000099',display_name:'Test Identity',needs_profile:false},{...role});
const demoAs=role=>page=>page.route('**/api/v1/auth/demo',r=>r.fulfill({json:{data:{token:'fixture-session-'+r.request().postDataJSON().role,user:me(role)}}}));
const STOP_LINK='http://127.0.0.1:4173/trips?from=00000000-0000-4000-8000-000000000200&to=00000000-0000-4000-8000-000000000203';

test('anonymous passenger searches without login and never sees cash',async({page})=>{
  await mockApi(page);
  await page.goto(STOP_LINK);
  await expect(page.getByText('Opérateur démo')).toBeVisible();
  await expect(page.getByRole('button',{name:'Choisir'}).first()).toBeEnabled();
  await expect(page.getByText(/espèces/i)).toHaveCount(0);
});

test('a result card leads with times, places and fare — not with internal metadata',async({page})=>{
  await mockApi(page);
  await page.goto(STOP_LINK);
  // Times first, then the exact boarding point, then the price.
  await expect(page.getByText('07:30')).toBeVisible();
  await expect(page.getByText('13:40')).toBeVisible();
  await expect(page.getByText('6 h 10')).toBeVisible();
  await expect(page.getByText(/Godomey – Carrefour/)).toBeVisible();
  await expect(page.getByText('7 500 FCFA')).toBeVisible();
  await expect(page.getByText('12 places')).toBeVisible();
  // A passenger never needs the plate or the driver's name to choose a trip.
  await expect(page.getByText('DEMO-BUS-01')).toHaveCount(0);
  await expect(page.getByText('Conducteur Démo')).toHaveCount(0);
});

test('a date with no departure falls forward instead of dead-ending',async({page})=>{
  await mockApi(page);
  await page.goto(STOP_LINK);
  // The fixture departs tomorrow, so today's default finds nothing and the
  // screen offers the next departures rather than an empty list.
  await expect(page.getByText(/voici les prochains départs/i)).toBeVisible();
  await expect(page.getByRole('button',{name:'Choisir'}).first()).toBeVisible();
});

test('search can be swapped and dated',async({page})=>{
  await mockApi(page);
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.getByLabel('Date')).toBeVisible();
  await page.getByLabel('Départ',{exact:true}).selectOption('place');
  await page.getByLabel('Ville de départ').click();await page.getByLabel('Ville de départ').fill('Cotonou');await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').click();await page.getByLabel('Destination').fill('Parakou');await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button',{name:'Inverser départ et arrivée'}).click();
  await expect(page.getByRole('button',{name:'Ville de départ : Parakou. Effacer'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Destination : Cotonou. Effacer'})).toBeVisible();
});

test('operator onboarding lives on its own public path with explicit choices',async({page})=>{
  await mockApi(page);
  await page.goto('http://127.0.0.1:4173/onboarding');
  await expect(page.getByText('Conduisez ou gérez votre compagnie.')).toBeVisible();
  await page.getByRole('button',{name:/Chauffeur indépendant/}).click();
  await expect(page.getByText(/votre profil conducteur et le bénéficiaire de vos recettes/)).toBeVisible();
  await page.getByRole('button',{name:'Retour',exact:true}).click();
  await page.getByRole('button',{name:/Compagnie de transport/}).click();
  await expect(page.getByText(/La compagnie devient opérateur LeRoutier/)).toBeVisible();
});

test('company driver sees crew navigation without revenue or fleet tools',async({page})=>{
  await mockApi(page);
  await demoAs({role:'driver',operator_type:'company',verification_status:'verified',operator_id:'00000000-0000-4000-8000-000000000001'})(page);
  await page.goto('http://127.0.0.1:4173/work/today');
  await page.getByRole('button',{name:'Développement : driver'}).click();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Aujourd’hui'})).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Manifeste'})).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Recettes'})).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button',{name:'Points'})).toHaveCount(0);
});

test('company crew reaching the revenue screen see no ledger and no withdrawal',async({page})=>{
  await mockApi(page);
  await demoAs({role:'driver',operator_type:'company',verification_status:'verified',operator_id:'00000000-0000-4000-8000-000000000001',operator_name:'Baobab Express'})(page);
  await page.goto('http://127.0.0.1:4173/work/earnings');
  await page.getByRole('button',{name:'Développement : driver'}).click();
  await expect(page.getByText(/reviennent à Baobab Express/)).toBeVisible();
  // No balance, no withdrawal control is presented to company crew at all.
  await expect(page.getByRole('button',{name:/retrait/i})).toHaveCount(0);
  await expect(page.getByText('Disponible')).toHaveCount(0);
});

test('independent owner-driver sees revenue, points and verification state',async({page})=>{
  await mockApi(page);
  await demoAs({role:'driver',operator_type:'independent',owner_user_id:'00000000-0000-4000-8000-000000000099',verification_status:'pending_verification',operator_id:'00000000-0000-4000-8000-000000000001'})(page);
  await page.route('**/api/v1/operator/settlements',r=>r.fulfill({json:{data:{summary:{available:12000,reserved:0,paid:0,reversed:0,currency:'XOF',verificationStatus:'pending_verification'},entries:[]}}}));
  await page.goto('http://127.0.0.1:4173/work/today');
  await page.getByRole('button',{name:'Développement : driver'}).click();
  // The verification state is phrased for the person waiting on it.
  await expect(page.getByText('Vérification en cours').first()).toBeVisible();
  await expect(page.getByText('pending_verification')).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button',{name:'Recettes'}).click();
  await expect(page.getByText('Recette de mon activité')).toBeVisible();
  await expect(page.getByText('12 000 FCFA')).toBeVisible();
  await expect(page.getByText(/retraits s’ouvriront dès la validation/)).toBeVisible();
  await page.getByRole('navigation').getByRole('button',{name:'Points'}).click();
  await expect(page.getByText('Proposer un nouveau point')).toBeVisible();
});

test('convoyeur gets crew-specific navigation without driver-centric items',async({page})=>{
  await mockApi(page);
  await demoAs({role:'convoyeur',operator_type:'company',verification_status:'verified',operator_id:'00000000-0000-4000-8000-000000000001'})(page);
  await page.goto('http://127.0.0.1:4173/work/today');
  await page.getByRole('button',{name:'Développement : convoyeur'}).click();
  await expect(page.locator('.lr-role-strip > span')).toHaveText('Convoyeur');
  await expect(page.getByText('Mon service')).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Service'})).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Scanner'})).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Véhicule'})).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button',{name:'Recettes'})).toHaveCount(0);
});

test('the crew home leads with the service, its load and big actions',async({page})=>{
  await mockApi(page);
  await demoAs({role:'driver',operator_type:'company',verification_status:'verified',operator_id:'00000000-0000-4000-8000-000000000001'})(page);
  await page.goto('http://127.0.0.1:4173/work/today');
  await page.getByRole('button',{name:'Développement : driver'}).click();
  await expect(page.getByText('07:30')).toBeVisible();
  await expect(page.getByText('à bord')).toBeVisible();
  await expect(page.getByText('places libres')).toBeVisible();
  await expect(page.getByRole('button',{name:'Scanner un billet'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Vendre une place'})).toBeVisible();
  // The raw service status never reaches the screen.
  await expect(page.getByText('active',{exact:true})).toHaveCount(0);
});

test('unprovisioned passenger identity gets a useful explanation in the crew workspace',async({page})=>{
  await mockApi(page);
  await demoAs({role:'passenger'})(page);
  await page.goto('http://127.0.0.1:4173/work/today');
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByText('Votre identité LeRoutier n’est pas encore rattachée à un opérateur comme chauffeur ou convoyeur. Passez par « Devenir opérateur ».')).toBeVisible();
});

test('verified Ops with no data sees a guided setup that opens each form',async({page})=>{
  await mockApi(page);
  await demoAs({role:'ops',operator_type:'company',verification_status:'verified',operator_id:'00000000-0000-4000-8000-000000000001'})(page);
  await page.route('**/api/v1/ops/provisioning',r=>r.fulfill({json:{data:{operators:[],users:[],routes:[],vehicles:[],places:[],stops:[]}}}));
  await page.route('**/api/v1/ops/fleet',r=>r.fulfill({json:{data:{services:[],vehicles:[]}}}));
  await page.route('**/api/v1/operators/*/stations',r=>r.fulfill({json:{data:[]}}));
  await page.goto('http://127.0.0.1:4173/ops/today');
  await page.getByRole('button',{name:'Développement : ops'}).click();
  await expect(page.getByText('Mettons votre compagnie en route')).toBeVisible();
  await expect(page.getByText('6 étapes restantes')).toBeVisible();
  // Each step is a real link to the form that completes it.
  await page.getByRole('button',{name:/Ajouter un véhicule/}).click();
  await expect(page).toHaveURL(/\/fleet$/);
});

test('ticket shows the exact boarding point, a short reference and a map affordance',async({page})=>{
  await mockApi(page);
  await page.route('**/api/v1/me/bookings',r=>r.fulfill({json:{data:[{id:'00000000-0000-4000-8000-000000000050',route_name:'DEMO Cotonou → Parakou',status:'confirmed',departure_at:'2026-09-16T08:00:00Z',seat_number:3,amount_minor:2500,departure_city:'Cotonou',departure_point_name:'Godomey – Carrefour',departure_point_landmark:'Au carrefour principal',departure_point_latitude:6.37,departure_point_longitude:2.39,arrival_city:'Parakou',arrival_point_name:'Gare de Parakou',arrival_point_landmark:null,arrival_point_latitude:null,arrival_point_longitude:null,service_id:'00000000-0000-4000-8000-000000000030'}]}}));
  await page.goto('http://127.0.0.1:4173/tickets');
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByText('Cotonou → Parakou')).toBeVisible();
  await expect(page.getByText(/Godomey – Carrefour/)).toBeVisible();
  await expect(page.getByRole('link',{name:/Voir le point d’embarquement/})).toBeVisible();
  // A quotable reference, never a raw identifier.
  await expect(page.getByText('00000000',{exact:true})).toBeVisible();
  await expect(page.getByText('00000000-0000-4000-8000-000000000050')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Afficher mon billet'})).toBeVisible();
});

test('empty production database shows the search form, never a passive empty card',async({page})=>{
  await mockApi(page);
  await page.route('**/api/v1/routes',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/api/v1/journey-plan*',r=>r.fulfill({json:{data:{options:[],originResolved:null,generatedAt:'2026-09-17T00:00:00Z'}}}));
  await page.goto('http://127.0.0.1:4173/');
  // The search form is built from geography: zero routes must not hide it.
  await expect(page.getByLabel('Départ',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Destination')).toBeVisible();
  await expect(page.getByRole('button',{name:'Rechercher un trajet'})).toBeVisible();
  await page.getByLabel('Départ',{exact:true}).selectOption('place');
  await page.getByLabel('Ville de départ').fill('Cotonou');await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').fill('Parakou');await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button',{name:'Rechercher un trajet'}).click();
  await expect(page.getByText('Aucun départ disponible pour cet itinéraire pour le moment.')).toBeVisible();
  await expect(page.getByText(/Entrez votre destination/)).toHaveCount(0);
});

test('quick search offers current location with a graceful manual fallback', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/journey-plan*', r => r.fulfill({ json: { data: { options: [], originResolved: null, generatedAt: '2026-09-17T00:00:00Z' } } }));
  await page.goto('http://127.0.0.1:4173/trips?from=my-location&to=place%3A00000000-0000-4000-8000-000000000303');
  const origin = page.getByLabel('Départ', { exact: true });
  await expect(origin.locator('option[value="current"]')).toHaveCount(1);
  // Permission denied → clear guidance and the manual path stays available.
  await page.context().grantPermissions([], { origin: 'http://127.0.0.1:4173' }).catch(() => {});
  await expect(page.getByRole('button', { name: 'Utiliser ma position actuelle' })).toBeVisible();
  await page.getByRole('button', { name: 'Utiliser ma position actuelle' }).click();
  await expect(page.getByText(/Position non disponible/)).toBeVisible();
  // The manual search path is never blocked by a missing GPS permission.
  await expect(origin).toBeVisible();
});

test('a granted position plans a door-to-destination itinerary with an honest no-result state', async ({ page }) => {
  await mockApi(page);
  const plans = [];
  await page.route('**/api/v1/journey-plan*', r => {
    plans.push(r.request().url());
    return r.fulfill({ json: { data: { options: [], originResolved: null, generatedAt: '2026-09-17T00:00:00Z' } } });
  });
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = cb => cb(/** @type {any} */({ coords: { latitude: 6.355, longitude: 2.435 } }));
  });
  await page.goto('http://127.0.0.1:4173/trips?from=my-location&to=place%3A00000000-0000-4000-8000-000000000303');
  await page.getByRole('button', { name: 'Utiliser ma position actuelle' }).click();
  await expect(page.getByText('Aucun départ disponible pour cet itinéraire pour le moment.')).toBeVisible();
  expect(plans.some(u => u.includes('lat=6.355')), 'the plan request carries the transient position').toBeTruthy();
});
