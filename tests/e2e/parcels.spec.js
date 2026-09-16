import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

test('passenger sends a parcel through a stepped flow and tracks it publicly',async({page})=>{
  // Session tokens are memory-only: navigate first, then sign in.
  await mockApi(page);
  await page.goto('http://127.0.0.1:4173/parcels');
  await expect(page.getByText('Envoyez un colis entre les villes.')).toBeVisible();
  await page.getByRole('button',{name:'Connexion de développement'}).click();

  // Step 1 — where is it going. Only route fields are asked for here.
  await expect(page.getByLabel('Ville de départ')).toBeVisible();
  await expect(page.getByLabel('Nom du destinataire')).toHaveCount(0);
  await page.getByLabel('Ville de départ').selectOption({label:'Cotonou'});
  await page.getByLabel('Ville d’arrivée').selectOption({label:'Parakou'});
  await page.getByRole('button',{name:'Continuer'}).click();

  // Step 2 — who is sending and receiving.
  await page.getByLabel('Votre nom').fill('Awa Sender');
  await page.getByLabel('Votre téléphone').fill('+229 61000001');
  await page.getByLabel('Nom du destinataire').fill('Kofi Receiver');
  await page.getByLabel('Téléphone du destinataire').fill('+229 61000002');
  await page.getByRole('button',{name:'Continuer'}).click();

  // Step 3 — contents and the operator's price, then confirm.
  await expect(page.getByText('1 000 FCFA', { exact: true })).toBeVisible();
  await page.getByRole('button',{name:'Confirmer l’envoi'}).click();
  await expect(page.getByText('Colis enregistré')).toBeVisible();
  await expect(page.getByText('LRP-12345678').first()).toBeVisible();
});

test('public parcel tracking shows a timeline and never party data',async({page})=>{
  await mockApi(page);
  await page.goto('http://127.0.0.1:4173/parcels');
  await page.getByLabel('Numéro de suivi').fill('LRP-12345678');
  await page.getByRole('button',{name:'Suivre mon colis'}).click();
  await expect(page.getByText('Cotonou → Parakou')).toBeVisible();
  await expect(page.getByText('En route').first()).toBeVisible();
  // A recognisable logistics timeline, not custody internals.
  await expect(page.getByText('Accepté')).toBeVisible();
  await expect(page.getByText('Prêt à retirer')).toBeVisible();
  // Neither the receiver's phone nor raw coordinates are public.
  await expect(page.getByText('+229 61000002')).toHaveCount(0);
  await expect(page.getByText(/7\.18|2\.11/)).toHaveCount(0);
});

test('driver sees parcel cargo on the assigned service and scans loading',async({page})=>{
  await mockApi(page);
  await page.goto('http://127.0.0.1:4174/');
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  // Sessions are memory-only: navigate client-side via the nav.
  await page.getByRole('navigation').getByRole('button',{name:'Colis'}).click();
  await expect(page.getByText('Fret & colis')).toBeVisible();
  await expect(page.getByText('LRP-12345678')).toBeVisible();
  await expect(page.getByText('destination Parakou')).toBeVisible();
  const scanRequest=page.waitForRequest(request=>request.url().includes('/api/v1/parcels/')&&request.url().endsWith('/scan')&&request.method()==='POST');
  await page.getByRole('button',{name:'Scanner le chargement'}).click();
  await scanRequest;
});
