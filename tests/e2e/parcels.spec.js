import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';

async function login(page,port){
  await mockApi(page);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByRole('button',{name:'Connexion de développement'}).click();
}

test('passenger creates a parcel, sees the receipt QR and tracks it publicly',async({page})=>{
  // Session tokens are memory-only: navigate first, then sign in.
  await mockApi(page);
  await page.goto('http://127.0.0.1:4173/parcels');
  await expect(page.getByText('Envoyez un colis avec les services LeRoutier existants.')).toBeVisible();
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByLabel('Expéditeur',{exact:true})).toBeVisible();
  await page.getByLabel('Expéditeur',{exact:true}).fill('Awa Sender');
  await page.getByLabel('Téléphone expéditeur').fill('+229 61000001');
  await page.getByLabel('Destinataire',{exact:true}).fill('Kofi Receiver');
  await page.getByLabel('Téléphone destinataire').fill('+229 61000002');
  await page.getByLabel('Départ').selectOption({label:'Cotonou · Gare démo'});
  await page.getByLabel('Arrivée').selectOption({label:'Parakou · Gare démo'});
  await expect(page.getByText('Prix estimé')).toBeVisible();
  await page.getByRole('button',{name:'Confirmer l’expédition'}).click();
  await expect(page.getByText('Reçu d’expédition')).toBeVisible();
  await expect(page.getByText('LRP-12345678').first()).toBeVisible();
  // Public tracking never shows party or payment data.
  await page.getByLabel('Numéro de suivi').fill('LRP-12345678');
  await page.getByRole('button',{name:'Suivre'}).click();
  await expect(page.getByText('En transit')).toBeVisible();
  await expect(page.getByText('Cotonou → Parakou')).toBeVisible();
  await expect(page.getByText(/Position approximative du véhicule transporteur/)).toBeVisible();
  await expect(page.getByText('+229 61000002')).toHaveCount(0);
});

test('driver sees parcel cargo on the assigned service and scans loading',async({page})=>{
  await login(page,4174);
  await expect(page.getByText('Fret & colis')).toBeVisible();
  await expect(page.getByText('LRP-12345678')).toBeVisible();
  await expect(page.getByText('destination Parakou')).toBeVisible();
  const scanRequest=page.waitForRequest(request=>request.url().includes('/api/v1/parcels/')&&request.url().endsWith('/scan')&&request.method()==='POST');
  await page.getByRole('button',{name:'Scanner le chargement'}).click();
  await scanRequest;
});
