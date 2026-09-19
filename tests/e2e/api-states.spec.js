import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';
test.use({baseURL:'http://127.0.0.1:4173'});
test.beforeEach(async({page})=>mockApi(page));

// The search form is built from geography, not from the route inventory:
// breaking /routes must not hide or degrade a single control.
test('the homepage search form does not depend on the route inventory',async({page})=>{
  await page.route('**/api/v1/routes',r=>r.fulfill({status:503,json:{error:{message:'Service indisponible.'}}}));
  await page.goto('/');
  await expect(page.getByLabel('Départ',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Destination')).toBeVisible();
  await expect(page.getByLabel('Date')).toBeVisible();
  await expect(page.getByRole('button',{name:'Rechercher un trajet'})).toBeVisible();
  await expect(page.getByText('503')).toHaveCount(0);
});

// A failing geography API is announced, and the form stays visible.
test('API error explains what failed and offers a way out',async({page})=>{
  await page.route('**/api/v1/places*',r=>r.fulfill({status:503,json:{error:{message:'Service indisponible.'}}}));
  await page.goto('/');
  await expect(page.getByText('Impossible de charger les villes pour le moment.').first()).toBeVisible();
  await expect(page.getByLabel('Départ',{exact:true})).toBeVisible();
  await expect(page.getByText('503')).toHaveCount(0);
  await page.unroute('**/api/v1/places*');await mockApi(page);
  await page.reload();
  await expect(page.getByText('Impossible de charger les villes pour le moment.')).toHaveCount(0);
});

test('empty search is rendered honestly with a way forward',async({page})=>{
  await page.route('**/api/v1/journey-plan*',r=>r.fulfill({json:{data:{options:[],originResolved:null,generatedAt:'2026-09-17T00:00:00Z'}}}));
  await page.goto('/');
  await page.getByLabel('Départ',{exact:true}).selectOption('place');
  await page.getByLabel('Ville de départ').fill('Cotonou');await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').fill('Parakou');await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button',{name:'Rechercher un trajet'}).click();
  await expect(page.getByText('Aucun départ disponible pour cet itinéraire pour le moment.')).toBeVisible();
  // Never a dead end: the search stays on screen with edit affordances.
  await expect(page.getByRole('button',{name:'Modifier la date'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Modifier le départ'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Modifier la destination'})).toBeVisible();
});

test('failed booking never displays success',async({page})=>{
  await page.route('**/api/v1/bookings',r=>r.fulfill({status:409,json:{error:{message:'No seat is available on every requested segment.'}}}));
  await page.goto('/');await page.getByRole('button',{name:'Connexion de développement'}).click();
  await page.getByLabel('Départ',{exact:true}).selectOption('place');
  await page.getByLabel('Ville de départ').fill('Cotonou');await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').fill('Parakou');await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button',{name:'Rechercher un trajet'}).click();
  await page.getByRole('button',{name:'Choisir'}).first().click();
  await expect(page).toHaveURL(/\/checkout/);
  // The booking is created only at the payment gate.
  await page.getByRole('button',{name:'Continuer vers le paiement'}).click();
  await expect(page.getByRole('alert')).toHaveText('No seat is available on every requested segment.');
  await expect(page).toHaveURL(/\/checkout/);
});

test('offline state disables booking actions',async({page,context})=>{
  await page.goto('/');await page.getByRole('button',{name:'Connexion de développement'}).click();
  await page.getByLabel('Départ',{exact:true}).selectOption('place');
  await page.getByLabel('Ville de départ').fill('Cotonou');await page.getByLabel('Ville de départ').press('Enter');
  await page.getByLabel('Destination').fill('Parakou');await page.getByLabel('Destination').press('Enter');
  await page.getByRole('button',{name:'Rechercher un trajet'}).click();
  await expect(page.getByRole('button',{name:'Choisir'}).first()).toBeEnabled();
  await page.getByRole('button',{name:'Choisir'}).first().click();
  await expect(page.getByRole('button',{name:'Continuer vers le paiement'})).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByText('Hors ligne — les actions nécessitent une connexion.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Continuer vers le paiement'})).toBeDisabled();
});
