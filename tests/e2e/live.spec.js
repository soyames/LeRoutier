import { test, expect } from '@playwright/test';
test('Passenger, Ops and Driver complete a real database-backed journey with real CX',async({browser})=>{
  const passenger=await browser.newPage(),ops=await browser.newPage(),driver=await browser.newPage();
  const errors=[];
  for(const page of [passenger,ops,driver]) page.on('pageerror',()=>errors.push('browser error'));

  // 1. Anonymous search over the real geography renders real Neon data
  //    before any authentication.
  await passenger.goto('http://127.0.0.1:4173/');
  await expect(passenger.getByText('Trouvez votre départ.')).toBeVisible();
  await passenger.getByLabel('Départ',{exact:true}).selectOption('place');
  await passenger.getByLabel('Ville de départ').fill('Cotonou');await passenger.getByLabel('Ville de départ').press('Enter');
  await passenger.getByLabel('Destination').fill('Parakou');await passenger.getByLabel('Destination').press('Enter');
  await passenger.getByRole('button',{name:'Rechercher un trajet'}).click();
  await expect(passenger.getByText('DEMO - Corridor Benin').first()).toBeVisible();
  await expect(passenger.getByRole('button',{name:'Se connecter pour réserver'}).first()).toBeEnabled();
  await expect(passenger.getByText(/espèces|comptant/i)).toHaveCount(0);

  // 2. Booking requires login; payment is online-only for passengers.
  await passenger.getByRole('button',{name:'Connexion de développement'}).click();
  await passenger.getByRole('button',{name:/Destination : .*\. Effacer/}).click();
  await passenger.getByLabel('Destination').fill('Bohicon');await passenger.getByLabel('Destination').press('Enter');
  await passenger.getByRole('button',{name:'Rechercher un trajet'}).click();
  await passenger.getByRole('button',{name:'Choisir ce trajet'}).click();
  await expect(passenger).toHaveURL(/\/tickets\//);
  await expect(passenger.getByText('À payer')).toBeVisible();

  // 3. Ops records the counter cash payment from the Payments section.
  await ops.goto('http://127.0.0.1:4173/ops/today');await ops.getByRole('button',{name:'Connexion de développement'}).click();
  await ops.getByRole('navigation').getByRole('button',{name:'Paiements'}).click();
  await expect(ops.getByLabel('Référence du reçu')).toBeVisible();
  await ops.getByLabel('Référence du reçu').fill('DEMO-E2E-RECEIPT');
  await expect(ops.getByRole('button',{name:'Enregistrer le paiement'}).first()).toBeEnabled();
  await ops.getByRole('button',{name:'Enregistrer le paiement'}).first().click();
  await expect(ops.getByText('Action enregistrée.')).toBeVisible({timeout:15000});

  // 4. Passenger confirms and issues the ticket with the real QR.
  await passenger.getByRole('button',{name:'Confirmer ma réservation'}).click();await expect(passenger.getByText('Confirmé',{exact:true})).toBeVisible();
  await passenger.getByRole('button',{name:'Afficher mon billet'}).click();
  await expect(passenger.getByText(/LR-[0-9A-F]{4}-[0-9A-F]{4}/)).toBeVisible();

  // 5. Driver boards and alights through the Manifest page; advances on Today.
  await driver.goto('http://127.0.0.1:4173/work/today');await driver.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(driver.getByText('à bord').first()).toBeVisible();
  await driver.getByRole('navigation').getByRole('button',{name:'Manifeste'}).click();
  await expect(driver.getByText('Passager Démo')).toBeVisible();
  await driver.getByRole('button',{name:'Embarquer',exact:true}).click();await expect(driver.getByRole('button',{name:'Embarquer',exact:true})).toHaveCount(0);
  await driver.getByRole('navigation').getByRole('button',{name:'Aujourd’hui'}).click();
  // The advance action names the stop the crew is arriving at.
  await driver.getByRole('button',{name:/^Je suis arrivé à /}).click();
  await expect(driver.getByText(/Arrivée à .* enregistrée\./)).toBeVisible();
  await driver.getByRole('navigation').getByRole('button',{name:'Manifeste'}).click();
  await driver.getByRole('button',{name:'Débarquer',exact:true}).click();await expect(driver.getByText('completed',{exact:true})).toBeVisible();
  await driver.getByRole('navigation').getByRole('button',{name:'Aujourd’hui'}).click();
  // Reporting is one tap away rather than a form sitting on the driving screen.
  await driver.getByRole('button',{name:'Signaler un problème'}).click();
  await driver.getByLabel('Que se passe-t-il ?').fill('Incident de démonstration E2E');
  await driver.getByRole('button',{name:'Envoyer le signalement'}).click();
  await expect(driver.getByText('Problème signalé à l’exploitation.')).toBeVisible();

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