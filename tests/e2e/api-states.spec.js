import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';
test.use({baseURL:'http://127.0.0.1:4173'});
test.beforeEach(async({page})=>mockApi(page));

test('API error explains what failed and offers a way out',async({page})=>{
  await page.route('**/api/v1/routes',r=>r.fulfill({status:503,json:{error:{message:'Service indisponible.'}}}));
  await page.goto('/');
  // The user is told what could not be loaded, not the status code.
  await expect(page.getByRole('alert')).toHaveText('Impossible de charger le réseau pour le moment.');
  await expect(page.getByText('503')).toHaveCount(0);
  await page.unroute('**/api/v1/routes');await mockApi(page);
  await page.getByRole('button',{name:'Réessayer'}).click();
  await expect(page.getByLabel('Départ',{exact:true})).toBeVisible();
});

test('empty search is rendered honestly with a way forward',async({page})=>{
  await page.route('**/api/v1/services?*',r=>r.fulfill({json:{data:[]}}));
  await page.goto('/');
  await expect(page.getByText('Aucun départ trouvé pour ce trajet.')).toBeVisible();
  // Never a dead end.
  await expect(page.getByRole('button',{name:'Inverser les villes'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Essayer demain'})).toBeVisible();
});

test('failed booking never displays success',async({page})=>{
  await page.route('**/api/v1/bookings',r=>r.fulfill({status:409,json:{error:{message:'No seat is available on every requested segment.'}}}));
  await page.goto('/');await page.getByRole('button',{name:'Connexion de développement'}).click();
  await page.getByRole('button',{name:'Choisir ce trajet'}).click();
  await expect(page.getByRole('alert')).toHaveText('No seat is available on every requested segment.');
  await expect(page).toHaveURL(/\/$/);
});

test('offline state disables booking actions',async({page,context})=>{
  await page.goto('/');await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByRole('button',{name:'Choisir ce trajet'})).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByText('Hors ligne — les actions nécessitent une connexion.')).toBeVisible();
});
