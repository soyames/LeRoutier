import { test, expect } from '@playwright/test';
test('Passenger, Ops and Driver complete a real database-backed journey',async({browser})=>{
  const passenger=await browser.newPage(),ops=await browser.newPage(),driver=await browser.newPage();
  const errors=[];
  for(const page of [passenger,ops,driver]) page.on('pageerror',()=>errors.push('browser error'));
  await passenger.goto('http://127.0.0.1:4173/');
  await passenger.getByRole('button',{name:'Connexion de développement'}).click();
  await passenger.getByLabel('Arrivée').selectOption({label:'Bohicon · Zakpo (démo)'});
  await passenger.getByRole('button',{name:'Réserver une place'}).click();
  await expect(passenger).toHaveURL(/\/tickets$/);
  await expect(passenger.getByText('Option en attente de paiement')).toBeVisible();
  await ops.goto('http://127.0.0.1:4175/');await ops.getByRole('button',{name:'Connexion de développement'}).click();
  await ops.getByLabel('Référence du reçu').fill('DEMO-E2E-RECEIPT');
  await ops.getByRole('button',{name:'Enregistrer le paiement'}).click();await expect(ops.getByText('Action enregistrée.')).toBeVisible();
  await passenger.getByRole('button',{name:'Confirmer la réservation'}).click();await expect(passenger.getByText('Confirmé',{exact:true})).toBeVisible();
  await driver.goto('http://127.0.0.1:4174/');await driver.getByRole('button',{name:'Connexion de développement'}).click();
  await driver.getByRole('button',{name:'Embarquer',exact:true}).click();await expect(driver.getByRole('button',{name:'Embarquer',exact:true})).toHaveCount(0);
  await driver.getByRole('button',{name:'Arrivée à l’arrêt suivant'}).click();
  await driver.getByRole('button',{name:'Débarquer',exact:true}).click();await expect(driver.getByText('completed',{exact:true})).toBeVisible();
  await driver.getByLabel('Description').fill('Incident de démonstration E2E');await driver.getByRole('button',{name:'Enregistrer l’incident'}).click();
  await expect(driver.getByText('Incident enregistré.')).toBeVisible();
  // Reload requires signing in again: session tokens are intentionally memory-only.
  await ops.reload();await ops.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(ops.getByText('Incident de démonstration E2E')).toBeVisible();await ops.getByRole('button',{name:'Résoudre'}).click();
  await passenger.reload();await passenger.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(passenger.getByText('Terminé',{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
  await Promise.all([passenger.close(),ops.close(),driver.close()]);
});
