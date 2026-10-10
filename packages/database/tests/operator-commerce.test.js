import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { commercial } from '../src/commercial.js';
import { operatorSettlements } from '../src/operator-settlements.js';
import { walkUpBookings } from '../src/walkup.js';
import { transport } from '../src/transport.js';
import { payments } from '../src/payments.js';
import { tickets } from '../src/tickets.js';
import { bookingDocument } from '../src/booking-document.js';
import { createApi } from '../../../services/api/src/app.js';
const config = { ...serverConfig(), schema:'lr_test_'+randomUUID().replaceAll('-',''), demoLogin:true };
const db = createDatabase(config);
const ops = { id:demo.ops, role:'ops',operator_id:demo.operator }, driver = { id:demo.driver,role:'driver',operator_id:demo.operator };
const passenger = { id:demo.passenger,role:'passenger' };
const one = (sql,args=[]) => db.transaction(async tx => (await tx.query(sql,args)).rows[0]);
let now = new Date('2027-04-30T22:59:59.999Z'), calls = 0, operatorOwner, independent, platform;
const events = new Map();
const adapter = { name:'fixture',environment:'live',payoutsAvailable:true,
  async initiate(input) { calls++; events.set(input.paymentId,{ kind:'payment',paymentId:input.paymentId,amountMinor:input.amountMinor,currency:'XOF',reference:'ref-'+input.paymentId,eventId:randomUUID(),status:'pending' }); return { reference:'ref-'+input.paymentId,checkoutUrl:'https://example.org/pay',metadata:{fixture:true} }; },
  async reconcilePayment(p) { return events.get(p.id) ?? null; },
  async reconcilePayout(p) { return { kind:'payout',payoutRequestId:p.id,eventId:randomUUID(),reference:p.provider_reference,amountMinor:p.amount_minor,currency:'XOF',status:'failed' }; },
  async createPayout() { throw new Error('network timeout'); },
};
const commerce = commercial(db,adapter,() => now), settle = operatorSettlements(db,adapter);
const contact = { name:'Transport Test',email:'billing@example.org',phone:'+2290197000000',address:'Cotonou, Bénin' };
before(async () => {
  await migrate(db); await seed(db);
  await db.transaction(async tx => {
    await tx.query('UPDATE operators SET admin_user_id=$2 WHERE id=$1',[demo.operator,demo.ops]);
    await tx.query('UPDATE services SET is_demo=false WHERE id=$1',[demo.service]);
    operatorOwner = (await tx.query("INSERT INTO users(display_name,role) VALUES('Owner','driver') RETURNING id")).rows[0].id;
    independent = (await tx.query("INSERT INTO operators(name,type,owner_user_id,verification_status) VALUES('Independent','independent',$1,'verified') RETURNING id",[operatorOwner])).rows[0].id;
    await tx.query('UPDATE users SET operator_id=$2 WHERE id=$1',[operatorOwner,independent]);
    await tx.query("INSERT INTO driver_profiles(user_id,operator_id,license_reference) VALUES($1,$2,'TEST')",[operatorOwner,independent]);
    platform = (await tx.query("INSERT INTO users(display_name,role) VALUES('Platform','ops') RETURNING id")).rows[0].id;
    await tx.query("INSERT INTO platform_grants(user_id,capability,granted_by) VALUES($1,'finance',$1)",[platform]);
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });
test('free selection saves contact and period, cannot initiate a charge or activate a paid period', async () => {
  const plan = await commerce.select(ops,{billingPeriod:'halfYear',billingContact:contact});
  assert.equal(plan.subscription.free,true); assert.equal(plan.prices.halfYear,180000);
  await assert.rejects(commerce.checkout(ops,{paymentMethod:'hosted'},randomUUID()),{code:'FREE_PERIOD'});
  assert.equal(calls,0); assert.equal((await one('SELECT paid_until FROM operator_subscriptions WHERE operator_id=$1',[demo.operator])).paid_until,null);
  const owner = { id:operatorOwner,role:'driver',operator_id:independent };
  const personal = await commerce.select(owner,{billingPeriod:'yearly',billingContact:contact});
  assert.equal(personal.prices.yearly,120000); assert.equal(personal.subscription.active,true);
  await assert.rejects(commerce.select(passenger,{billingPeriod:'yearly',billingContact:contact}),{code:'FORBIDDEN'});
});
test('pending or forged success cannot activate; verified money starts at verification and replays do not extend', async () => {
  now = new Date('2027-04-30T23:00:00Z');
  const p = await commerce.checkout(ops,{paymentMethod:'hosted'},randomUUID());
  await commerce.webhook({paymentId:p.id,status:'succeeded'});
  assert.equal((await commerce.plan(ops)).subscription.active,false);
  events.get(p.id).status = 'succeeded'; events.get(p.id).amountMinor = 1;
  await assert.rejects(commerce.reconcile(ops,p.id),{code:'PAYMENT_MISMATCH'});
  events.get(p.id).amountMinor = 180000;
  now = new Date('2027-05-03T10:00:00Z');
  await commerce.reconcile(ops,p.id);
  const paid = await commerce.plan(ops);
  assert.equal(paid.subscription.nextDueAt.toISOString(),'2027-11-03T10:00:00.000Z');
  await commerce.reconcile(ops,p.id);
  assert.equal((await commerce.plan(ops)).subscription.nextDueAt.toISOString(),paid.subscription.nextDueAt.toISOString());
  assert.equal(paid.receipts[0].status,'succeeded');
});
test('expired operator functions are gated, while passengers and financial reads remain accessible', async () => {
  now = new Date('2028-05-01T00:00:00Z');
  await assert.rejects(commerce.requireActive(ops),{code:'SUBSCRIPTION_REQUIRED'});
  await commerce.requireActive({...passenger,operator_id:demo.operator});
  await settle.summary(ops);
  const api = createApi(db,{...config,subscriptionClock:() => now},undefined,/** @type {any} */(adapter));
  async function session(role) { const r = await api(new Request('http://localhost/api/v1/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})})); return (await r.json()).data.token; }
  const token = await session('passenger'), opToken = await session('ops');
  const booking = await api(new Request('http://localhost/api/v1/bookings',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({serviceId:demo.service,origin:0,destination:1})}));
  assert.equal(booking.status,200);
  const publication = await api(new Request('http://localhost/api/v1/ops/services',{method:'POST',headers:{authorization:'Bearer '+opToken,'content-type':'application/json'},body:'{}'}));
  assert.equal(publication.status,402);
});
test('cash sale records total and platform debt, never credits withdrawable cash fare; collections are auditable and idempotent', async () => {
  const input = {serviceId:demo.service,origin:0,destination:1,passengerName:'Cash Passenger',passengerPhone:'+2290197111111',amountMinor:2500,cashReference:'cash-unique'};
  const key = randomUUID(), sale = await walkUpBookings(db)(driver,input,key);
  await walkUpBookings(db)(driver,input,key);
  const fee = await one('SELECT * FROM operator_cash_fees WHERE booking_id=$1',[sale.bookingId]);
  assert.equal(fee.fare_minor,2500); assert.equal(fee.fee_minor,50); assert.equal(fee.cash_received_minor,2550);
  assert.equal((await one("SELECT payout_state FROM operator_settlements WHERE source='walk_up' AND reference=$1",['walkup:'+sale.bookingId])).payout_state,'direct');
  const admin = {id:platform,role:'ops',operator_id:null};
  const receipt = await settle.collectCashFee(admin,fee.id,{amountMinor:20,reference:'bank-statement-001'});
  assert.equal((await settle.collectCashFee(admin,fee.id,{amountMinor:20,reference:'bank-statement-001'})).id,receipt.id);
  await assert.rejects(settle.collectCashFee(admin,fee.id,{amountMinor:31,reference:'bank-statement-002'}),{code:'INVALID_COLLECTION'});
  assert.equal((await one('SELECT collected_minor FROM operator_cash_fees WHERE id=$1',[fee.id])).collected_minor,20);
});
test('invoice and provider-confirmed refunds include separate fees; fare debt is limited to refunded fare', async () => {
  const b = await transport(db).hold(passenger,{serviceId:demo.service,origin:0,destination:1},randomUUID());
  const pay = payments(db,adapter), p = await pay.initiate(passenger,b.id,{},randomUUID());
  const event = events.get(p.id); event.status='succeeded'; event.providerFeeMinor=100;
  await pay.applyEvent(event);
  let invoice = await db.transaction(tx => bookingDocument(tx,b.id));
  assert.equal(invoice.fareMinor,2500); assert.equal(invoice.platformFeeMinor,50); assert.equal(invoice.providerFeeMinor,100); assert.equal(invoice.paidMinor,2650);
  assert.equal(invoice.seller,'DEMO - Corridor Benin');
  assert.equal((await tickets(db).issue(passenger,b.id)).validForBoarding,true,'separate provider fees do not block passenger boarding');
  await pay.applyEvent({...event,eventId:randomUUID(),refundedMinor:600,operatorRefundedMinor:500});
  invoice = await db.transaction(tx => bookingDocument(tx,b.id)); assert.equal(invoice.refundedMinor,600);
  assert.equal((await one('SELECT amount_minor FROM operator_settlement_reversals WHERE payment_id=$1',[p.id])).amount_minor,500);
  await pay.applyEvent({...event,eventId:randomUUID(),status:'refunded',refundedMinor:2650,operatorRefundedMinor:2500});
  invoice = await db.transaction(tx => bookingDocument(tx,b.id)); assert.equal(invoice.refundedMinor,2650);
  assert.equal((await one('SELECT amount_minor FROM operator_settlement_reversals WHERE payment_id=$1',[p.id])).amount_minor,2500);
});
test('monthly payouts require consent; prior-month boundaries, cash exclusion, partial debt offsets and retries are idempotent', async () => {
  const admin = {id:platform,role:'ops',operator_id:null};
  assert.equal((await settle.capability()).canRequest,false,'secret alone cannot prove capability');
  await db.transaction(tx=>tx.query(`INSERT INTO operator_payout_schedules(operator_id,enabled,phone_number,country,consented_by)
    VALUES($1,true,'0197000000','BJ',$2)`,[demo.operator,demo.ops]));
  assert.equal((await settle.payoutSchedule(ops)).enabled,false,'legacy consent must not be shown as an active monthly mandate');
  assert.equal((await settle.runMonthly('2026-10-01')).manual,0);
  await settle.setPayoutSchedule(ops,{enabled:true,consentVersion:'monthly-v1',phoneNumber:'0197000000',country:'BJ',network:null});
  await db.transaction(async tx => {
    await tx.query('DELETE FROM operator_settlement_reversals');
    await tx.query("UPDATE operator_settlements SET payout_state='direct'");
    await tx.query(`INSERT INTO operator_settlements(operator_id,source,reference,gross_minor,earned_at,available_at,payout_state) VALUES
      ($1,'ticket_online','prior-start',1000,'2026-09-01 00:00:00+01','2026-09-01','available'),
      ($1,'ticket_online','prior-end',9000,'2026-10-01 00:00:00+01','2026-10-01 00:00:00+01','available'),
      ($1,'walk_up','cash-already-received',8000,'2026-09-10','2026-09-10','direct')`,[demo.operator]);
    const payment = (await tx.query('SELECT id FROM payments LIMIT 1')).rows[0];
    await tx.query('INSERT INTO operator_settlement_reversals(payment_id,operator_id,amount_minor) VALUES($1,$2,1500)',[payment.id,demo.operator]);
  });
  const first = await settle.runMonthly('2026-10-01');
  assert.equal(first.manual,0,'debt consumes the 1000 available, leaves 500 debt');
  assert.equal((await one('SELECT amount_minor-settled_minor AS debt FROM operator_settlement_reversals')).debt,500);
  await db.transaction(tx => tx.query("INSERT INTO operator_settlements(operator_id,source,reference,gross_minor,earned_at,available_at) VALUES($1,'ticket_online','later-prior',2000,'2026-09-15','2026-09-15')",[demo.operator]));
  await settle.runMonthly('2026-10-01');
  const next={requests:(await settle.list(ops)).filter(p=>p.payoutKind==='monthly')};
  assert.equal(next.requests[0].amountMinor,1500);
  await settle.runMonthly('2026-10-01');
  assert.equal((await settle.list(ops)).filter(p=>p.payoutKind==='monthly').length,1);
  await assert.rejects(settle.approve(admin,next.requests[0].id),{code:'PAYOUT_UNAVAILABLE'});
  assert.equal((await one('SELECT status FROM operator_payout_requests WHERE id=$1',[next.requests[0].id])).status,'requested');
  // Confirmed provider failure releases the reservation. A request with a provider
  // reference cannot initiate a second transfer, even after failure.
  await db.transaction(tx => tx.query("UPDATE operator_payout_requests SET status='processing',provider_reference='existing-provider-payout' WHERE id=$1",[next.requests[0].id]));
  await settle.reconcile(admin,next.requests[0].id);
  assert.equal((await one('SELECT status FROM operator_payout_requests WHERE id=$1',[next.requests[0].id])).status,'failed');
  assert.equal((await one('SELECT count(*)::integer AS n FROM operator_settlements WHERE payout_request_id=$1',[next.requests[0].id])).n,0);
  await assert.rejects(settle.approve(admin,next.requests[0].id),{code:'PAYOUT_UNAVAILABLE'});
  const manual={confirmedAmountMinor:1500,reference:'bank-confirmed-2026-10',confirmation:'Bank statement verified by finance'};
  const receipt=await settle.manualSettlement(admin,next.requests[0].id,manual);
  assert.equal(receipt.status,'paid');
  assert.equal((await settle.manualSettlement(admin,receipt.id,manual)).id,receipt.id);
  assert.equal((await settle.capability()).canRequest,false,'manual transfers are not provider capability');
  assert.equal((await one('SELECT amount_minor-settled_minor AS debt FROM operator_settlement_reversals')).debt,0);
  await settle.setPayoutSchedule(ops,{enabled:false,consentVersion:'monthly-v1',phoneNumber:'0197000000',country:'BJ',network:null});
  assert.equal((await settle.runMonthly('2026-11-01')).manual,0);
});

test('capability proof is account and environment specific; an uncertain monthly transfer stays reserved without a second attempt', async () => {
  const proofId=randomUUID(), proofKey=randomUUID();
  await db.transaction(tx=>tx.query(`INSERT INTO operator_payout_requests(id,operator_id,amount_minor,phone_number,country,provider,status,idempotency_key,request_fingerprint,provider_metadata)
    VALUES($1,$2,1,'0197000000','BJ','fixture','paid',$3,'fixture',$4)`,
    [proofId,demo.operator,proofKey,JSON.stringify({verifiedEnvironment:'sandbox',verifiedAccount:'fixture'})]));
  assert.equal((await settle.capability()).canRequest,false,'sandbox proof cannot enable live transfers');
  await db.transaction(tx=>tx.query('UPDATE operator_payout_requests SET provider_metadata=$2 WHERE id=$1',
    [proofId,JSON.stringify({verifiedEnvironment:'live',verifiedAccount:'other-account'})]));
  assert.equal((await settle.capability()).canRequest,false,'a different merchant account cannot enable transfers');
  await db.transaction(tx=>tx.query('UPDATE operator_payout_requests SET provider_metadata=$2 WHERE id=$1',
    [proofId,JSON.stringify({verifiedEnvironment:'live',verifiedAccount:'fixture'})]));
  assert.equal((await settle.capability()).canRequest,true);
  await settle.setPayoutSchedule(ops,{enabled:true,consentVersion:'monthly-v1',phoneNumber:'0197000000',country:'BJ',network:null});
  let attempts=0;
  const uncertain=operatorSettlements(db,{...adapter,async createPayout(){attempts++;throw new Error('response lost after provider acceptance');}});
  const result=await uncertain.runMonthly('2026-11-01');
  assert.equal(result.failed,1);assert.equal(attempts,1);
  const pending=await one("SELECT id,status,amount_minor FROM operator_payout_requests WHERE operator_id=$1 AND payout_kind='monthly' AND payout_period='2026-10-01'",[demo.operator]);
  assert.equal(pending.status,'processing');assert.equal(pending.amount_minor,9000);
  assert.equal((await one('SELECT payout_state FROM operator_settlements WHERE reference=$1',['prior-end'])).payout_state,'reserved');
  await uncertain.runMonthly('2026-11-01');assert.equal(attempts,1,'monthly retry never resends an ambiguous transfer');
  const admin={id:platform,role:'ops',operator_id:null};
  await assert.rejects(uncertain.manualSettlement(admin,pending.id,{confirmedAmountMinor:9000,reference:'bank-unknown-transfer',confirmation:'A separate bank statement'}),{code:'PAYOUT_RECONCILE_REQUIRED'});
  const historicId=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO operator_payout_requests(id,operator_id,amount_minor,phone_number,country,provider,status,idempotency_key,request_fingerprint)
      VALUES($1,$2,8000,'0197000000','BJ','fixture','requested',$3,'historic')`,[historicId,demo.operator,randomUUID()]);
    await tx.query("UPDATE operator_settlements SET payout_state='reserved',payout_request_id=$1 WHERE reference='cash-already-received'",[historicId]);
  });
  await assert.rejects(uncertain.approve(admin,historicId),{code:'CASH_RECONCILIATION_REQUIRED'});
  assert.equal(attempts,1,'historic cash reservations cannot send cash fare a second time');
});
