import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

const me=role=>Object.assign({id:'00000000-0000-4000-8000-000000000099',display_name:'Test Identity',needs_profile:false},{...role});
const demoAs=role=>page=>page.route('**/api/v1/auth/demo',r=>r.fulfill({json:{data:{token:'fixture-session-'+r.request().postDataJSON().role,user:me(role)}}}));

test('anonymous passenger searches without login and never sees cash',async({page})=>{
  await mockApi(page);
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.getByText('Opérateur démo')).toBeVisible();
  await expect(page.getByRole('button',{name:'Se connecter pour réserver'})).toBeEnabled();
  await expect(page.getByText(/espèces|comptant/i)).toHaveCount(0);
});

test('operator onboarding lives on its own public path with explicit choices',async({page})=>{
  await mockApi(page);
  await page.goto('http://127.0.0.1:4173/onboarding');
  await expect(page.getByText('Vous voyagez, vous conduisez ou vous gérez une compagnie ?')).toBeVisible();
  await page.getByRole('button',{name:'Chauffeur indépendant'}).click();
  await expect(page.getByText(/Un seul compte devient votre opérateur/)).toBeVisible();
  await page.getByRole('button',{name:'Retour',exact:true}).click();
  await page.getByRole('button',{name:'Compagnie de transport'}).click();
  await expect(page.getByText(/La compagnie devient un opérateur/)).toBeVisible();
});

test('company driver sees crew navigation without revenue or fleet tools',async({page})=>{
  await mockApi(page);
  await demoAs({role:'driver',operator_type:'company',verification_status:'verified',operator_id:'00000000-0000-4000-8000-000000000001'})(page);
  await page.goto('http://127.0.0.1:4174/');
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Aujourd’hui'})).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Manifeste'})).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Gains'})).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button',{name:'Points'})).toHaveCount(0);
});

test('independent owner-driver sees earnings, points and verification state',async({page})=>{
  await mockApi(page);
  await demoAs({role:'driver',operator_type:'independent',verification_status:'pending_verification',operator_id:'00000000-0000-4000-8000-000000000001'})(page);
  await page.route('**/api/v1/operator/settlements',r=>r.fulfill({json:{data:{summary:{available:12000,reserved:0,paid:0,reversed:0,currency:'XOF',verificationStatus:'pending_verification'},entries:[]}}}));
  await page.goto('http://127.0.0.1:4174/');
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByText('Statut : pending_verification')).toBeVisible();
  await page.getByRole('navigation').getByRole('button',{name:'Gains'}).click();
  await expect(page.getByText('Recette de mon activité indépendante')).toBeVisible();
  await expect(page.getByText('Compte en attente de vérification — les retraits seront possibles après validation.')).toBeVisible();
  await page.getByRole('navigation').getByRole('button',{name:'Points'}).click();
  await expect(page.getByText('Proposer un nouveau point')).toBeVisible();
});

test('convoyeur gets crew-specific navigation without driver-centric items',async({page})=>{
  await mockApi(page);
  await demoAs({role:'convoyeur',operator_type:'company',verification_status:'verified',operator_id:'00000000-0000-4000-8000-000000000001'})(page);
  await page.goto('http://127.0.0.1:4174/');
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.locator('.lr-role-strip > span')).toHaveText('Convoyeur');
  await expect(page.getByRole('navigation').getByRole('button',{name:'Service'})).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Scanner'})).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button',{name:'Véhicule'})).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button',{name:'Gains'})).toHaveCount(0);
});

test('unprovisioned passenger identity gets a useful explanation in the driver app',async({page})=>{
  await mockApi(page);
  await demoAs({role:'passenger'})(page);
  await page.goto('http://127.0.0.1:4174/');
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByText('Votre compte passager n’est pas encore provisionné comme équipage. Créez un compte opérateur ou demandez votre provisionnement.')).toBeVisible();
});

test('verified Ops with no data sees the guided setup checklist',async({page})=>{
  await mockApi(page);
  await demoAs({role:'ops',operator_type:'company',verification_status:'verified',operator_id:'00000000-0000-4000-8000-000000000001'})(page);
  await page.route('**/api/v1/ops/provisioning',r=>r.fulfill({json:{data:{operators:[],users:[],routes:[],vehicles:[],places:[],stops:[]}}}));
  await page.route('**/api/v1/ops/fleet',r=>r.fulfill({json:{data:{services:[],vehicles:[]}}}));
  await page.route('**/api/v1/operators/*/stations',r=>r.fulfill({json:{data:[]}}));
  await page.goto('http://127.0.0.1:4175/');
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByText('Configurez votre compagnie')).toBeVisible();
  await expect(page.getByText('Ajouter un véhicule')).toBeVisible();
  await expect(page.getByText('Publier le premier service')).toBeVisible();
});

test('ticket shows the exact boarding point with a map affordance',async({page})=>{
  await mockApi(page);
  await page.route('**/api/v1/me/bookings',r=>r.fulfill({json:{data:[{id:'00000000-0000-4000-8000-000000000050',route_name:'DEMO Cotonou → Parakou',status:'confirmed',departure_at:'2026-09-16T08:00:00Z',seat_number:3,amount_minor:2500,departure_city:'Cotonou',departure_point_name:'Godomey – Carrefour',departure_point_landmark:'Au carrefour principal',departure_point_latitude:6.37,departure_point_longitude:2.39,arrival_city:'Parakou',arrival_point_name:'Gare de Parakou',arrival_point_landmark:null,arrival_point_latitude:null,arrival_point_longitude:null,service_id:'00000000-0000-4000-8000-000000000030'}]}}));
  await page.goto('http://127.0.0.1:4173/tickets');
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByText(/Godomey – Carrefour/)).toBeVisible();
  await expect(page.getByText('Voir l’embarquement sur la carte')).toBeVisible();
});

test('empty production database shows honest product empty states',async({page})=>{
  await mockApi(page);
  await page.route('**/api/v1/routes',r=>r.fulfill({json:{data:[]}}));
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.getByText('Aucune ligne n’est publiée pour le moment. Revenez bientôt — le réseau s’ouvre progressivement.')).toBeVisible();
});
