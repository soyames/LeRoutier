import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { transport } from '../src/transport.js';
import { payments } from '../src/payments.js';
import { earnings, payouts } from '../src/payouts.js';
import { tickets } from '../src/tickets.js';
import { fedapayAdapter } from '../../../services/api/src/fedapay.js';
import { createApi } from '../../../services/api/src/app.js';

// FedaPay adapter against a fake HTTP transport: no live provider calls in CI.
// All webhook payloads are signed with the official scheme (t=...,s=...).
const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),d=transport(db);
const passenger={id:demo.passenger,role:'passenger'},driver={id:demo.driver,role:'driver'},ops={id:demo.ops,role:'ops',operator_id:demo.operator};
const webhookSecret='wh_sandbox_fedapay_test_placeholder!';
const adapterConfig={paymentProvider:'fedapay',production:false,
  fedapay:{environment:'sandbox',secretKey:'sk_sandbox_test_placeholder',payoutSecretKey:'pk_sandbox_test_placeholder',webhookSecret:webhookSecret}};
const transactions=new Map(),payoutsStore=new Map();
let nextTx=40,nextPayout=70,failPayouts=false,currentTx=null;
async function fakeHttp(url,init){
  const path=new URL(url).pathname,method=init?.method||'GET',body=init?.body?JSON.parse(init.body):undefined;
  if(path==='/v1/transactions'&&method==='POST'){
    const tx={id:++nextTx,reference:`T-${nextTx}`,status:'pending',amount:body.amount,currency:{iso:body.currency.iso},custom_metadata:body.custom_metadata,updated_at:new Date().toISOString()};
    transactions.set(tx.id,tx);currentTx=tx;return new Response(JSON.stringify(tx),{status:201});
  }
  const token=path.match(/^\/v1\/transactions\/(\d+)\/token$/);
  if(token&&method==='POST'){const tx=transactions.get(Number(token[1]));return tx?new Response(JSON.stringify({token:'tok_'+tx.id,url:`https://process.fedapay.com/tok_${tx.id}`}),{status:200}):new Response('{}',{status:404});}
  const getTx=path.match(/^\/v1\/transactions\/(\d+)$/);
  if(getTx&&method==='GET'){const tx=transactions.get(Number(getTx[1]));return tx?new Response(JSON.stringify(tx),{status:200}):new Response('{}',{status:404});}
  if(path==='/v1/payouts'&&method==='POST'){
    if(failPayouts)return new Response('{}',{status:422});
    const payout={id:++nextPayout,reference:`P-${nextPayout}`,status:'pending',amount:body.amount,currency:{iso:body.currency.iso},custom_metadata:body.custom_metadata,updated_at:new Date().toISOString()};
    payoutsStore.set(payout.id,payout);return new Response(JSON.stringify(payout),{status:201});
  }
  if(path==='/v1/payouts/start'&&method==='PUT')return new Response(JSON.stringify([{id:77,reference:'P-77',status:'started'}]),{status:200});
  const getPayout=path.match(/^\/v1\/payouts\/(\d+)$/);
  if(getPayout&&method==='GET'){const p=payoutsStore.get(Number(getPayout[1]));return p?new Response(JSON.stringify(p),{status:200}):new Response('{}',{status:404});}
  return new Response('{}',{status:404});
}
const adapter=fedapayAdapter(adapterConfig,fakeHttp);
const pay=payments(db,adapter),earn=earnings(db),payout=payouts(db,adapter,{payoutApprovalRequired:true});
let api;
const hold=()=>d.hold(passenger,{serviceId:demo.service,origin:0,destination:1},randomUUID());
async function intent(){const b=await hold();return {b,p:await pay.initiate(passenger,b.id,{},randomUUID())};}
const sign=(raw,timestamp=Math.floor(Date.now()/1000))=>`t=${timestamp},s=${createHmac('sha256',webhookSecret).update(`${timestamp}.${raw}`).digest('hex')}`;
const headers=raw=>new Headers({'x-fedapay-signature':sign(raw)});
function txEvent(type,paymentId,status,amount=2500,currency='XOF'){
  const tx=currentTx ?? {id:40,reference:'T-40',amount:2500};
  return {id:randomUUID().slice(0,8),type,entity:{id:tx.id,reference:tx.reference,status,amount,currency:{iso:currency},custom_metadata:{app:'leroutier',payment_id:paymentId}}};
}
async function webhook(event){const raw=JSON.stringify(event);return pay.webhook('fedapay',raw,headers(raw));}
async function paid(){const {b,p}=await intent();await webhook(txEvent('transaction.approved',p.id,'approved'));return {b,p};}
function payoutEvent(requestId,status,amount=3000,reference='P-71'){
  return {id:randomUUID().slice(0,8),type:'payout.'+status,entity:{id:71,reference,status,amount,currency:{iso:'XOF'},custom_metadata:{app:'leroutier',payout_request_id:requestId}}};
}
before(async()=>{await migrate(db);await seed(db);await db.transaction(async tx => {
  await tx.query('UPDATE routes SET active=true, is_demo=false WHERE id=$1', [demo.route]);
  await tx.query('UPDATE services SET is_demo=false WHERE id=$1', [demo.service]);
});api=createApi(db,config,undefined,adapter);});
beforeEach(async()=>{failPayouts=false;transactions.clear();payoutsStore.clear();currentTx=null;nextTx=39;nextPayout=70;
  await db.transaction(async tx=>{await tx.query('DELETE FROM booking_segments');await tx.query("UPDATE bookings SET status='cancelled'");await tx.query('DELETE FROM payment_events');await tx.query('DELETE FROM payments');await tx.query('DELETE FROM payout_events');await tx.query('DELETE FROM driver_earnings');await tx.query('DELETE FROM payout_requests');await tx.query('DELETE FROM payout_destinations');await tx.query('DELETE FROM outbox');await tx.query("UPDATE services SET current_sequence=0,status='active'");});});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});

test('collection initiation persists the provider reference and metadata',async()=>{
  const {p}=await intent();
  assert.equal(p.providerReference,p.provider_reference);
  const row=await db.transaction(async tx=>(await tx.query('SELECT * FROM payments WHERE id=$1',[p.id])).rows[0]);
  assert.equal(row.provider_reference,'T-40');
  assert.equal(row.provider_metadata.fedapayId,40);
  assert.match(row.checkout_url,/^https:\/\//);
  assert.equal(row.provider_metadata.checkoutToken,'tok_40');
});
test('trusted successful webhook confirms the booking atomically',async()=>{
  const {b,p}=await intent();
  await webhook(txEvent('transaction.approved',p.id,'approved'));
  assert.equal((await d.booking(passenger,b.id)).status,'confirmed');
});
test('invalid webhook signatures are rejected before any processing',async()=>{
  const {b,p}=await intent();
  const raw=JSON.stringify(txEvent('transaction.approved',p.id,'approved'));
  await assert.rejects(pay.webhook('fedapay',raw,new Headers({'x-fedapay-signature':sign(raw,Math.floor(Date.now()/1000)-301)})),{code:'INVALID_WEBHOOK'});
  await assert.rejects(pay.webhook('fedapay',raw,new Headers({'x-fedapay-signature':'t=1,s=beef'.repeat(9)})),{code:'INVALID_WEBHOOK'});
  await assert.rejects(pay.webhook('fedapay',raw,new Headers({})),{code:'INVALID_WEBHOOK'});
  assert.equal((await d.booking(passenger,b.id)).status,'held');
});
test('duplicate webhook delivery records one event and confirms once',async()=>{
  const {b,p}=await intent();
  const event=txEvent('transaction.approved',p.id,'approved');
  await Promise.all([webhook(event),webhook(event)]);
  const count=await db.transaction(async tx=>(await tx.query('SELECT count(*)::integer AS n FROM payment_events WHERE payment_id=$1',[p.id])).rows[0].n);
  assert.equal(count,1);
  assert.equal((await d.booking(passenger,b.id)).status,'confirmed');
});
test('amount and currency mismatches never confirm and raise an anomaly via the API route',async()=>{
  const {b,p}=await intent();
  await assert.rejects(webhook(txEvent('transaction.approved',p.id,'approved',2501)),{code:'PAYMENT_MISMATCH'});
  await assert.rejects(webhook(txEvent('transaction.approved',p.id,'approved',2500,'USD')),{code:'INVALID_PAYMENT_EVENT'});
  assert.equal((await d.booking(passenger,b.id)).status,'held');
  // Through the dedicated API route the anomaly is acknowledged with 200 and
  // queued for the reconciliation workflow (FedaPay expects a 2xx response).
  const raw=JSON.stringify(txEvent('transaction.approved',p.id,'approved',2501));
  const r=await api(new Request('http://localhost/api/v1/webhooks/fedapay',{method:'POST',headers:{'x-fedapay-signature':sign(raw)},body:raw}));
  assert.equal(r.status,200);
  const body=await r.json();
  assert.equal(body.data.anomaly,true);
  const anomaly=await db.transaction(async tx=>(await tx.query("SELECT * FROM outbox WHERE event_type='payment.anomaly'")).rows);
  assert.equal(anomaly.length,1);
  assert.equal(anomaly[0].payload.paymentId,p.id);
});
test('events for unknown or non-LeRoutier transactions are safely ignored',async()=>{
  const {b}=await intent();
  const foreign={id:9,type:'transaction.approved',entity:{id:99,reference:'T-OTHER',status:'approved',amount:2500,currency:{iso:'XOF'},custom_metadata:{app:'another-product'}}};
  assert.deepEqual(await webhook(foreign),{ignored:true});
  const unknown={id:10,type:'transaction.approved',entity:{id:40,reference:'T-40',status:'approved',amount:2500,currency:{iso:'XOF'},custom_metadata:{app:'leroutier',payment_id:randomUUID()}}};
  await assert.rejects(webhook(unknown),{code:'NOT_FOUND'});
  const customer={id:11,type:'customer.created',entity:{id:5}};
  assert.deepEqual(await webhook(customer),{ignored:true});
  assert.equal((await d.booking(passenger,b.id)).status,'held');
});
test('failed and cancelled provider events never confirm the booking',async()=>{
  for(const [type,status] of [['transaction.declined','declined'],['transaction.canceled','canceled']]){
    const {b,p}=await intent();
    await webhook(txEvent(type,p.id,status));
    assert.equal((await d.booking(passenger,b.id)).status,'held');
  }
});
test('reconciliation applies the trusted provider status',async()=>{
  const {b,p}=await intent();
  currentTx.status='approved';
  await pay.reconcile(passenger,p.id);
  assert.equal((await d.booking(passenger,b.id)).status,'confirmed');
});
test('payout request reserves available earnings and rejects duplicates',async()=>{
  await earn.credit({driverId:demo.driver,source:'fixture',reference:'trip-1',grossMinor:5000});
  const destination=await payout.addDestination(driver,{country:'BJ',phoneNumber:'61234567',network:'mtn'});
  const key=randomUUID(),first=await payout.request(driver,{destinationId:destination.id,amountMinor:3000},key);
  assert.equal(first.status,'requested');
  const replayed=await payout.request(driver,{destinationId:destination.id,amountMinor:3000},key);
  assert.equal(replayed.id,first.id);
  assert.deepEqual(await earn.summary(driver),{available:2000,reserved:3000,paid:0,reversed:0,currency:'XOF'});
});
test('insufficient driver balance rejects a withdrawal',async()=>{
  await earn.credit({driverId:demo.driver,source:'fixture',reference:'trip-2',grossMinor:1000});
  const destination=await payout.addDestination(driver,{country:'BJ',phoneNumber:'61234567'});
  await assert.rejects(payout.request(driver,{destinationId:destination.id,amountMinor:5000},randomUUID()),{code:'INSUFFICIENT_BALANCE'});
});
test('a driver cannot withdraw through another driver’s destination',async()=>{
  await earn.credit({driverId:demo.driver,source:'fixture',reference:'trip-3',grossMinor:5000});
  const theirs=await payout.addDestination(driver,{country:'BJ',phoneNumber:'61234567'});
  // Provision a second, real driver on the same operator (test fixture).
  const otherId=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,auth_subject,auth_issuer,display_name,role,operator_id,profile_completed_at) VALUES($1,$2,'test','Second Driver','driver',$3,now())`,[otherId,'fedapay-test-driver-2',demo.operator]);
    await tx.query('INSERT INTO driver_profiles(user_id,operator_id,license_reference,active) VALUES($1,$2,$3,true)',[otherId,demo.operator,'LIC-002']);
  });
  const otherDriver={id:otherId,role:'driver'};
  await assert.rejects(payout.request(otherDriver,{destinationId:theirs.id,amountMinor:1000},randomUUID()),{code:'INVALID_DESTINATION'});
});
test('successful FedaPay payout marks ledger entries paid only after provider confirmation',async()=>{
  await earn.credit({driverId:demo.driver,source:'fixture',reference:'trip-4',grossMinor:5000});
  const destination=await payout.addDestination(driver,{country:'BJ',phoneNumber:'61234567'});
  const request=await payout.request(driver,{destinationId:destination.id,amountMinor:3000},randomUUID());
  const approved=await payout.approve(ops,request.id);
  assert.equal(approved.status,'processing');
  assert.equal(approved.providerReference,'P-71');
  assert.equal((await earn.summary(driver)).reserved,3000,'balance stays reserved while processing');
  const raw=JSON.stringify(payoutEvent(request.id,'sent'));
  const applied=await payout.webhook('fedapay',raw,headers(raw));
  assert.equal(applied.status,'paid');
  assert.deepEqual(await earn.summary(driver),{available:2000,reserved:0,paid:3000,reversed:0,currency:'XOF'});
  const rows=await db.transaction(async tx=>(await tx.query('SELECT payout_state,net_minor FROM driver_earnings ORDER BY earned_at,id')).rows);
  assert.deepEqual(rows.map(r=>[r.payout_state,r.net_minor]).sort(),[['available',2000],['paid',3000]].sort());
});
test('failed payout releases the reserved balance and returns to a retryable state',async()=>{
  await earn.credit({driverId:demo.driver,source:'fixture',reference:'trip-5',grossMinor:5000});
  const destination=await payout.addDestination(driver,{country:'BJ',phoneNumber:'61234567'});
  const request=await payout.request(driver,{destinationId:destination.id,amountMinor:3000},randomUUID());
  failPayouts=true;
  await assert.rejects(payout.approve(ops,request.id),{code:'PAYOUT_UNAVAILABLE'});
  assert.deepEqual(await earn.summary(driver),{available:5000,reserved:0,paid:0,reversed:0,currency:'XOF'});
  const failed=await db.transaction(async tx=>(await tx.query('SELECT status FROM payout_requests WHERE id=$1',[request.id])).rows[0]);
  assert.equal(failed.status,'failed');
  // Retry after the provider recovers: approval re-reserves and re-executes.
  failPayouts=false;
  const retried=await payout.approve(ops,request.id);
  assert.equal(retried.status,'processing');
  assert.deepEqual(await earn.summary(driver),{available:2000,reserved:3000,paid:0,reversed:0,currency:'XOF'});
});
test('payout events for unknown requests and foreign products are ignored safely',async()=>{
  const foreign=JSON.stringify(payoutEvent(randomUUID(),'sent'));
  await assert.rejects(payout.webhook('fedapay',foreign,headers(foreign)),{code:'NOT_FOUND'});
  const noMarker={id:5,type:'payout.sent',entity:{id:71,reference:'P-71',status:'sent',amount:3000,currency:{iso:'XOF'},custom_metadata:{app:'elsewhere',payout_request_id:randomUUID()}}};
  const raw=JSON.stringify(noMarker);
  assert.deepEqual(await payout.webhook('fedapay',raw,headers(raw)),{ignored:true});
});
test('unpaid bookings never produce a boarding QR; paid ones do',async()=>{
  const unpaid=await hold();
  await assert.rejects(tickets(db).issue(passenger,unpaid.id),{code:'TICKET_INVALID'});
  const {b}=await paid();
  const ticket=await tickets(db).issue(passenger,b.id);
  assert.ok(ticket.token.startsWith('LRT1.'));
});
