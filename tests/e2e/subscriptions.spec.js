import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockApi } from './api-fixture.js';
const APP='http://127.0.0.1:4173';
const prices={monthly:10000,halfYear:60000,yearly:120000};
async function operator(page, overrides={}) {
  await mockApi(page);
  const user={id:'00000000-0000-4000-8000-000000000099',role:'driver',operator_id:'00000000-0000-4000-8000-000000000001',operator_type:'independent',owner_user_id:'00000000-0000-4000-8000-000000000099',display_name:'Test Operator',verification_status:'verified',needs_profile:false};
  await page.route('**/api/v1/auth/demo',r=>r.fulfill({json:{data:{token:'fixture-session',user}}}));
  await page.route('**/api/v1/me',r=>r.fulfill({json:{data:user}}));
  let plan={operatorType:'independent',prices,paymentMethods:[{id:'hosted',label:'Paiement sécurisé'}],subscription:{active:true,free:true,billingPeriod:null,nextDueAt:'2027-04-30T23:00:00Z'},receipts:[],...overrides};
  const selections=[];
  await page.route('**/api/v1/operator/subscription',r=>{
    if(r.request().method()==='POST'){const body=r.request().postDataJSON();selections.push(body);plan={...plan,subscription:{...plan.subscription,billingPeriod:body.billingPeriod,billingContact:body.billingContact}};}
    return r.fulfill({json:{data:plan}});
  });
  await page.goto(APP+'/work/profile');
  await page.getByRole('button',{name:'Connexion de développement'}).click();
  await expect(page.getByRole('region',{name:'Abonnement professionnel'})).toBeVisible();
  return {selections,setPlan(value){plan=value;},getPlan(){return plan;}};
}
test('public subscription cards expose both exact prices and deliberate selection',async({page})=>{
  await mockApi(page);await page.goto(APP+'/professionnel');
  const cards=page.locator('.subscription-card');await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText(/10\s*000/);await expect(cards.nth(0)).toContainText(/60\s*000/);await expect(cards.nth(0)).toContainText(/120\s*000/);
  await expect(cards.nth(1)).toContainText(/30\s*000/);await expect(cards.nth(1)).toContainText(/180\s*000/);await expect(cards.nth(1)).toContainText(/360\s*000/);
  await expect(page.getByRole('button',{name:'Choisir cette formule'})).toHaveCount(2);
  expect((await new AxeBuilder({page}).include('.subscription-cards').analyze()).violations).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  if(page.viewportSize().width<640){const first=await cards.nth(0).boundingBox(),second=await cards.nth(1).boundingBox();expect(second.y).toBeGreaterThanOrEqual(first.y+first.height);}
  await cards.first().locator('..').screenshot({path:test.info().outputPath('subscription-cards.png')});
});
test('free checkout confirms contact and period without starting a payment',async({page})=>{
  const state=await operator(page);let charges=0;
  await page.route('**/api/v1/operator/subscription/checkout',r=>{charges++;return r.fulfill({status:409,json:{error:{message:'Free period'}}});});
  await page.getByRole('button',{name:'Choisir cette formule'}).click();
  await page.getByLabel('Période de facturation').selectOption('halfYear');
  await page.getByLabel('Nom / raison sociale').fill('Independent Test');await page.getByLabel('Adresse de facturation').fill('Cotonou');
  await page.getByLabel('Email de contact').fill('billing@example.org');await page.getByLabel('Téléphone',{exact:true}).fill('0197000000');
  await page.getByRole('checkbox',{name:/Je confirme mes coordonnées/}).check();
  await page.getByRole('button',{name:'Confirmer ma formule gratuite'}).click();
  await expect(page.getByRole('status').filter({hasText:/Aucun montant débité/})).toBeVisible();
  expect(charges).toBe(0);expect(state.selections[0].billingPeriod).toBe('halfYear');expect(state.selections[0].billingContact.email).toBe('billing@example.org');
});
test('pending and failed states never claim confirmation; server verification creates a receipt',async({page})=>{
  const state=await operator(page,{subscription:{active:false,free:false,billingPeriod:'monthly',nextDueAt:'2027-04-30T23:00:00Z'},receipts:[{id:'pending',status:'pending',amount_minor:10000,billing_period:'monthly'},{id:'failed',status:'failed',amount_minor:10000,billing_period:'monthly'}]});
  await expect(page.getByRole('status',{name:''}).filter({hasText:'Paiement en attente de vérification'})).toBeVisible();
  await expect(page.getByText('Paiement échoué',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Imprimer le reçu'})).toHaveCount(0);
  await page.route('**/api/v1/operator/subscription/payments/pending/reconcile',r=>{
    state.setPlan({...state.getPlan(),subscription:{active:true,free:false,billingPeriod:'monthly',nextDueAt:'2027-06-01T00:00:00+01:00'},receipts:[{id:'pending',status:'succeeded',amount_minor:10000,billing_period:'monthly',verified_at:'2027-05-01T00:00:00+01:00',period_start:'2027-05-01T00:00:00+01:00',period_end:'2027-06-01T00:00:00+01:00',provider_reference:'verified-provider-reference'}]});
    return r.fulfill({json:{data:{status:'succeeded'}}});
  });
  await page.getByRole('button',{name:'Vérifier le paiement'}).click();await expect(page.getByRole('button',{name:'Imprimer le reçu'})).toBeVisible();
  await expect(page.getByText(/verified-provider-reference/)).toBeVisible();
});
test('paid checkout requires billing review and a supported method before creating a pending intent',async({page})=>{
  const state=await operator(page,{subscription:{active:false,free:false,billingPeriod:null,nextDueAt:'2027-04-30T23:00:00Z'}});let charges=0;
  await page.route('**/api/v1/operator/subscription/checkout',r=>{charges++;expect(r.request().postDataJSON()).toEqual({paymentMethod:'hosted'});return r.fulfill({json:{data:{id:'verified-intent',status:'pending'}}});});
  await page.getByRole('button',{name:'Choisir cette formule'}).click();await page.getByLabel('Période de facturation').selectOption('yearly');
  await page.getByLabel('Nom / raison sociale').fill('Operator Test');await page.getByLabel('Adresse de facturation').fill('Cotonou');
  await page.getByLabel('Email de contact').fill('billing@example.org');await page.getByLabel('Téléphone',{exact:true}).fill('0197000000');
  await page.getByRole('button',{name:/Payer/}).click();expect(charges).toBe(0);
  await page.getByLabel('Moyen de paiement').selectOption('hosted');await page.getByRole('checkbox',{name:/Je confirme mes coordonnées/}).check();
  await page.getByRole('button',{name:/Payer/}).click();await expect(page.getByRole('status').filter({hasText:/activé après vérification/})).toBeVisible();
  expect(charges).toBe(1);expect(state.selections[0].billingPeriod).toBe('yearly');await expect(page.getByRole('button',{name:'Imprimer le reçu'})).toHaveCount(0);
});
