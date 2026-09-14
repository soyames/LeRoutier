import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';
test.use({baseURL:'http://127.0.0.1:4173'});
test.beforeEach(async({page})=>mockApi(page));
test('API error is visible and can be retried',async({page})=>{
  await page.route('**/routes',r=>r.fulfill({status:503,json:{error:{message:'Service indisponible.'}}}));
  await page.goto('/');await expect(page.getByRole('alert')).toHaveText('Service indisponible.');
  await page.unroute('**/routes');await mockApi(page);
  await page.getByRole('button',{name:'Réessayer'}).click();await expect(page.getByLabel('Départ')).toBeVisible();
});
test('empty search is rendered honestly',async({page})=>{
  await page.route('**/services?*',r=>r.fulfill({json:{data:[]}}));await page.goto('/');await expect(page.getByText('Aucun départ pour ce trajet.')).toBeVisible();
});
test('failed booking never displays success',async({page})=>{
  await page.route('**/bookings',r=>r.fulfill({status:409,json:{error:{message:'No seat is available on every requested segment.'}}}));
  await page.goto('/');await page.getByRole('button',{name:'Connexion de développement'}).click();
  await page.getByRole('button',{name:'Réserver une place'}).click();await expect(page.getByRole('alert')).toHaveText('No seat is available on every requested segment.');await expect(page).toHaveURL(/\/$/);
});
test('offline state disables booking actions',async({page,context})=>{
  await page.goto('/');await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByRole('button',{name:'Réserver une place'})).toBeEnabled();await context.setOffline(true);
  await expect(page.getByText('Hors ligne — les actions nécessitent une connexion.')).toBeVisible();
});
