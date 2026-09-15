import { test, expect } from '@playwright/test';
test('Passenger, Ops and Driver complete a real database-backed journey with real CX',async({browser})=>{
  const passenger=await browser.newPage(),ops=await browser.newPage(),driver=await browser.newPage();
  const errors=[];
  for(const page of [passenger,ops,driver]) page.on('pageerror',()=>errors.push('browser error'));

  // 1. Anonymous search renders real Neon data before any authentication.
  await passenger.goto('http://127.0.0.1:4173/');
  await expect(passenger.getByText('Voyagez entre les villes du Bénin, simplement.')).toBeVisible();
  await expect(passenger.getByText('DEMO - Corridor Benin')).toBeVisible();
  await expect(passenger.getByText('DEMO-BUS-01').first()).toBeVisible();
  await expect(passenger.getByRole('button',{name:'Se connecter pour réserver'}).first()).toBeEnabled();
  await expect(passenger.getByText(/espèces|comptant/i)).toHaveCount(0);

  // 2. Booking requires login; payment is online-only for passengers.
  await passenger.getByRole('button',{name:'Connexion de développement'}).click();
  await passenger.getByLabel('Arrivée').selectOption({label:'Bohicon · Zakpo (démo)'});
  await passenger.getByRole('button',{name:'Réserver une place'}).click();
  await expect(passenger).toHaveURL(/\/tickets$/);
  await expect(passenger.getByText('Option en attente de paiement')).toBeVisible();

  // 3. Ops records the counter cash payment from the Payments section.
  await ops.goto('http://127.0.0.1:4175/');await ops.getByRole('button',{name:'Connexion de développement'}).click();
  await ops.getByRole('navigation').getByRole('button',{name:'Paiements'}).click();
  await expect(ops.getByLabel('Référence du reçu')).toBeVisible();
  await ops.getByLabel('Référence du reçu').fill('DEMO-E2E-RECEIPT');
  await expect(ops.getByRole('button',{name:'Enregistrer le paiement'}).first()).toBeEnabled();
  await ops.getByRole('button',{name:'Enregistrer le paiement'}).first().click();
  await expect(ops.getByText('Action enregistrée.')).toBeVisible({timeout:15000});

  // 4. Passenger confirms and issues the ticket with the real QR.
  await passenger.getByRole('button',{name:'Confirmer la réservation'}).click();await expect(passenger.getByText('Confirmé',{exact:true})).toBeVisible();
  await passenger.getByRole('button',{name:'Obtenir mon billet (QR)'}).click();
  await expect(passenger.getByText(/LR-[0-9A-F]{4}-[0-9A-F]{4}/)).toBeVisible();

  // 5. Driver boards and alights through the Manifest page; advances on Today.
  await driver.goto('http://127.0.0.1:4174/');await driver.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(driver.getByText('DEMO-BUS-01').first()).toBeVisible();
  await driver.getByRole('navigation').getByRole('button',{name:'Manifeste'}).click();
  await expect(driver.getByText('Passager Démo')).toBeVisible();
  await driver.getByRole('button',{name:'Embarquer',exact:true}).click();await expect(driver.getByRole('button',{name:'Embarquer',exact:true})).toHaveCount(0);
  await driver.getByRole('navigation').getByRole('button',{name:'Aujourd’hui'}).click();
  await driver.getByRole('button',{name:'Arrivée à l’arrêt suivant'}).click();
  await expect(driver.getByText('Arrêt suivant enregistré.')).toBeVisible();
  await driver.getByRole('navigation').getByRole('button',{name:'Manifeste'}).click();
  await driver.getByRole('button',{name:'Débarquer',exact:true}).click();await expect(driver.getByText('completed',{exact:true})).toBeVisible();
  await driver.getByRole('navigation').getByRole('button',{name:'Aujourd’hui'}).click();
  await driver.getByLabel('Description').fill('Incident de démonstration E2E');await driver.getByRole('button',{name:'Enregistrer l’incident'}).click();
  await expect(driver.getByText('Incident enregistré.')).toBeVisible();

  // 6. Ops resolves the incident and sees real diagnostics and fleet.
  // Reload requires signing in again: session tokens are intentionally memory-only.
  await ops.reload();await ops.getByRole('button',{name:'Connexion de développement'}).click();
  await ops.getByRole('navigation').getByRole('button',{name:'Aujourd’hui'}).click();
  await expect(ops.getByText('Services aujourd’hui')).toBeVisible();
  await ops.getByRole('navigation').getByRole('button',{name:'Incidents'}).click();
  await expect(ops.getByText('Incident de démonstration E2E')).toBeVisible();await ops.getByRole('button',{name:'Résoudre'}).click();
  await ops.getByRole('navigation').getByRole('button',{name:'Flotte'}).click();
  await expect(ops.getByText('DEMO-BUS-01').first()).toBeVisible();

  await passenger.reload();await passenger.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(passenger.getByText('Terminé',{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
  await Promise.all([passenger.close(),ops.close(),driver.close()]);
});