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

// ------------------------------------------------- who may take the money --
// The six ownership rules, asserted against the running domain rather than
// inferred from where a button is drawn. A UI that hides a control is not a
// control: every one of these has to fail at the server.
test('revenue belongs to the operator, and only an independent owner may withdraw it',async()=>{
  const {operatorSettlements}=await import('../src/operator-settlements.js');
  const settle=operatorSettlements(db,adapter);
  const company=await db.transaction(async tx=>(await tx.query(
    `INSERT INTO operators(name,type,verification_status) VALUES('Compagnie Test','company','verified') RETURNING *`)).rows[0]);
  const make=async(role,operatorId,extra={})=>{
    const id=randomUUID();
    await db.transaction(async tx=>{
      await tx.query(`INSERT INTO users(id,display_name,role,operator_id,profile_completed_at)
        VALUES($1,$2,$3,$4,now())`,[id,role+'-'+id.slice(0,4),role,operatorId]);
      if(role==='driver')await tx.query(`INSERT INTO driver_profiles(user_id,operator_id,license_reference,active)
        VALUES($1,$2,$3,true)`,[id,operatorId,'PC-'+id.slice(0,8)]);
      if(role==='convoyeur')await tx.query('INSERT INTO convoyeur_profiles(user_id,operator_id,active) VALUES($1,$2,true)',[id,operatorId]);
      if(extra.owns)await tx.query('UPDATE operators SET owner_user_id=$2 WHERE id=$1',[operatorId,id]);
      if(extra.admins)await tx.query('UPDATE operators SET admin_user_id=$2 WHERE id=$1',[operatorId,id]);
    });
    return {id,role,operator_id:operatorId};
  };
  const companyDriver=await make('driver',company.id);
  const companyOps=await make('ops',company.id,{admins:true});
  const convoyeur=await make('convoyeur',company.id);
  // Real revenue on the company ledger.
  await db.transaction(tx=>settle.credit(tx,{operatorId:company.id,source:'ticket_online',
    reference:'test:'+randomUUID(),grossMinor:100000,deductionMinor:10000}));

  const withdrawal={amountMinor:1000,phoneNumber:'97000111',country:'BJ',network:null};
  // A company driver is paid by their employer. The company revenue is not
  // theirs to move, however senior they are.
  await assert.rejects(settle.request(companyDriver,withdrawal,randomUUID()),{code:'FORBIDDEN'});
  // Neither is it the administrator's: a company settles on its own terms, and
  // the platform does not hand its balance to whoever holds the admin seat.
  await assert.rejects(settle.request(companyOps,withdrawal,randomUUID()),{code:'FORBIDDEN'});
  // A convoyeur collects cash and never owns revenue. This is the cash
  // collector / revenue owner separation, stated as a refusal.
  await assert.rejects(settle.request(convoyeur,withdrawal,randomUUID()),{code:'FORBIDDEN'});
  await assert.rejects(payout.request(convoyeur,{destinationId:randomUUID(),amountMinor:1000},randomUUID()),{code:'FORBIDDEN'});
  // And the company balance is still intact after all of that.
  const balance=await db.transaction(async tx=>(await tx.query(
    `SELECT sum(net_minor)::integer AS total FROM operator_settlements WHERE operator_id=$1 AND payout_state='available'`,[company.id])).rows[0]);
  assert.equal(balance.total,90000,'nothing was reserved or moved by a refused request');
});

test('one operator can never approve, read or reconcile another operator payout',async()=>{
  const {operatorSettlements}=await import('../src/operator-settlements.js');
  const settle=operatorSettlements(db,adapter);
  const foreignOps={id:randomUUID(),role:'ops',operator_id:randomUUID()};
  const owner=await db.transaction(async tx=>{
    const id=randomUUID();
    await tx.query(`INSERT INTO users(id,display_name,role,operator_id,profile_completed_at)
      VALUES($1,'Independant Retrait','driver',$2,now())`,[id,demo.operator]);
    await tx.query(`INSERT INTO driver_profiles(user_id,operator_id,license_reference,active) VALUES($1,$2,'PC-IND-1',true)`,[id,demo.operator]);
    await tx.query(`UPDATE operators SET owner_user_id=$2,type='independent',verification_status='verified' WHERE id=$1`,[demo.operator,id]);
    return {id,role:'driver',operator_id:demo.operator};
  });
  await db.transaction(tx=>settle.credit(tx,{operatorId:demo.operator,source:'walk_up',
    reference:'cash:'+randomUUID(),grossMinor:50000,deductionMinor:5000}));
  const request=await settle.request(owner,{amountMinor:2000,phoneNumber:'97000222',country:'BJ',network:null},randomUUID());

  // A different operator Ops cannot touch it, in any direction.
  await assert.rejects(settle.approve(foreignOps,request.id),{code:'FORBIDDEN'});
  await assert.rejects(settle.reconcile(foreignOps,request.id),{code:'FORBIDDEN'});
  // The owner-driver cannot approve their own withdrawal: requesting and
  // releasing money are two decisions, and one account never holds both.
  await assert.rejects(settle.approve(owner,request.id),{code:'FORBIDDEN'});
  // A passenger is nowhere near any of it.
  await assert.rejects(settle.approve({id:demo.passenger,role:'passenger'},request.id),{code:'FORBIDDEN'});
});

test('a withdrawal is reserved once: approving twice cannot pay twice',async()=>{
  const {operatorSettlements}=await import('../src/operator-settlements.js');
  const settle=operatorSettlements(db,adapter);
  const platformOps={id:demo.ops,role:'ops',operator_id:null};
  const owner=await db.transaction(async tx=>{
    const id=randomUUID();
    await tx.query(`INSERT INTO users(id,display_name,role,operator_id,profile_completed_at)
      VALUES($1,'Double Retrait','driver',$2,now())`,[id,demo.operator]);
    await tx.query(`INSERT INTO driver_profiles(user_id,operator_id,license_reference,active) VALUES($1,$2,'PC-IND-2',true)`,[id,demo.operator]);
    await tx.query(`UPDATE operators SET owner_user_id=$2,type='independent',verification_status='verified' WHERE id=$1`,[demo.operator,id]);
    return {id,role:'driver',operator_id:demo.operator};
  });
  await db.transaction(tx=>settle.credit(tx,{operatorId:demo.operator,source:'walk_up',
    reference:'cash:'+randomUUID(),grossMinor:20000,deductionMinor:0}));
  const key=randomUUID();
  const first=await settle.request(owner,{amountMinor:5000,phoneNumber:'97000444',country:'BJ',network:null},key);
  // Same key, same request: one row, one reservation.
  const repeat=await settle.request(owner,{amountMinor:5000,phoneNumber:'97000444',country:'BJ',network:null},key);
  assert.equal(repeat.id,first.id);
  // Same key, different amount: refused rather than silently answering about
  // the first request.
  await assert.rejects(settle.request(owner,{amountMinor:9000,phoneNumber:'97000444',country:'BJ',network:null},key),
    {code:'IDEMPOTENCY_CONFLICT'});
  await settle.approve(platformOps,first.id);
  // Already processing: a second approval is a state error, not a second payout.
  await assert.rejects(settle.approve(platformOps,first.id),{code:'PAYOUT_TRANSITION'});
  const reserved=await db.transaction(async tx=>(await tx.query(
    `SELECT sum(net_minor)::integer AS total FROM operator_settlements WHERE payout_request_id=$1`,[first.id])).rows[0]);
  assert.equal(reserved.total,5000,'exactly the requested amount is held, once');
});

// ------------------------------------- what the platform may claim it can do --
// `payoutsAvailable` only ever meant "a secret key is set in the environment".
// Whether FedaPay ACTIVATED Payouts for this merchant is a fact about their
// account that no environment variable knows — and reporting it as available
// showed a driver a withdrawal button, took the request, reserved the balance,
// and failed at the provider.
test('payout capability reports what is proven, not what is configured',async()=>{
  const {payouts}=await import('../src/payouts.js');

  // No adapter at all.
  assert.deepEqual(await payouts(db,null,{}).capability(),
    {state:'missing_provider',canRequest:false,provider:null});

  // An adapter whose payout key is absent. Collections may still work; paying
  // somebody out is a different credential and a different account permission.
  const noKey=payouts(db,{name:'fedapay',payoutsAvailable:false},{});
  const missing=await noKey.capability();
  assert.equal(missing.state,'missing_credentials');
  assert.equal(missing.canRequest,false);

  // Credentials present, nothing ever attempted. Requests are allowed — that
  // is how a first transfer ever happens — but nothing claims it will land.
  await db.transaction(tx=>tx.query("DELETE FROM payout_requests WHERE provider='fedapay'"));
  const fresh=await payout.capability();
  assert.equal(fresh.state,'configured');
  assert.equal(fresh.canRequest,true,'the first payout has to be possible');
  assert.notEqual(fresh.state,'available','credentials are not proof');
});

test('a provider that refuses every transfer is reported as not activated',async()=>{
  const {b}=await paid();
  await earn.credit({driverId:demo.driver,source:'ride',reference:'cap:'+randomUUID(),grossMinor:9000});
  const destination=await payout.addDestination(driver,{country:'BJ',phoneNumber:'97000777'});
  failPayouts=true;
  const request=await payout.request(driver,{destinationId:destination.id,amountMinor:3000},randomUUID());
  await assert.rejects(payout.approve(ops,request.id),{code:'PAYOUT_UNAVAILABLE'});

  // This is exactly what an unactivated FedaPay Payouts account looks like
  // from here, and it is the most useful thing to tell somebody.
  const refused=await payout.capability();
  assert.equal(refused.state,'provider_not_activated');
  assert.equal(refused.canRequest,false,'a driver is not invited to try again into the same wall');
  // The balance came back; nothing was lost while the platform learned this.
  const summary=await earn.summary(driver);
  assert.ok(summary.available>=3000,'the reserved amount was released: '+JSON.stringify(summary));
  assert.ok(b);

  // One completed transfer is what turns the claim true.
  failPayouts=false;
  await payout.approve(ops,request.id);
  const settled=JSON.stringify(payoutEvent(request.id,'sent'));
  await payout.webhook('fedapay',settled,headers(settled));
  const proven=await payout.capability();
  assert.equal(proven.state,'available');
  assert.equal(proven.canRequest,true);
});

// ----------------------------------------------- collection integrity ------
test('a passenger cannot influence what they are charged',async()=>{
  const b=await hold();
  // The intent body must be empty: amount and currency are the booking's, and
  // the route whitelists nothing a caller could put there.
  for(const hostile of [{amountMinor:1},{amount:1},{currency:'EUR'},{status:'succeeded'},{bookingId:b.id}]){
    await assert.rejects(pay.initiate(passenger,b.id,hostile,randomUUID()),{code:'INVALID_PAYMENT'},
      JSON.stringify(hostile)+' was accepted as payment input');
  }
  const intent=await pay.initiate(passenger,b.id,{},randomUUID());
  const stored=await db.transaction(async tx=>(await tx.query('SELECT amount_minor,currency FROM payments WHERE id=$1',[intent.id])).rows[0]);
  assert.equal(stored.amount_minor,b.amount_minor,'the amount is the booking’s, server-side');
  assert.equal(stored.currency,'XOF');

  // And a provider event claiming a different amount never confirms anything.
  const cheated=txEvent('transaction.approved',intent.id,'approved',1);
  await assert.rejects(webhook(cheated),{code:'PAYMENT_MISMATCH'});
  const after=await db.transaction(async tx=>(await tx.query('SELECT status FROM bookings WHERE id=$1',[b.id])).rows[0]);
  assert.equal(after.status,'held','the booking is not confirmed by a mismatched event');
});

test('a replayed webhook is idempotent; a reused event id with new data is refused',async()=>{
  const {b,p}=await intent();
  const event=txEvent('transaction.approved',p.id,'approved');
  await webhook(event);
  const confirmed=await db.transaction(async tx=>(await tx.query('SELECT status FROM bookings WHERE id=$1',[b.id])).rows[0]);
  assert.equal(confirmed.status,'confirmed');

  // The same delivery again, byte for byte: one event row, one confirmation.
  await webhook(event);
  await webhook(event);
  const events=await db.transaction(async tx=>(await tx.query(
    'SELECT count(*)::int AS n FROM payment_events WHERE payment_id=$1 AND event_id=$2',[p.id,event.id])).rows[0]);
  assert.equal(events.n,1,'a provider retry is not a second payment');

  // Same identifier, different content: that is not a retry, and accepting it
  // would let anybody overwrite a settled payment by reusing an id.
  const forged={...event,entity:{...event.entity,status:'canceled'}};
  await assert.rejects(webhook(forged),{code:'EVENT_CONFLICT'});
});

test('an unsigned or stale webhook never reaches the domain',async()=>{
  const {p}=await intent();
  const raw=JSON.stringify(txEvent('transaction.approved',p.id,'approved'));
  for(const [label,header] of [
    ['missing',new Headers({})],
    ['garbage',new Headers({'x-fedapay-signature':'nonsense'})],
    ['wrong key',new Headers({'x-fedapay-signature':`t=${Math.floor(Date.now()/1000)},s=${'0'.repeat(64)}`})],
    ['stale',new Headers({'x-fedapay-signature':sign(raw,Math.floor(Date.now()/1000)-4000)})],
  ]){
    await assert.rejects(pay.webhook('fedapay',raw,header),{code:'INVALID_WEBHOOK'},`${label} signature was accepted`);
  }
  const untouched=await db.transaction(async tx=>(await tx.query('SELECT status FROM payments WHERE id=$1',[p.id])).rows[0]);
  assert.equal(untouched.status,'pending');
});

test('a TEST service can never take real money, in either direction',async()=>{
  // The TEST corridor is restored for this case only; the suite otherwise runs
  // the seeded service as real inventory.
  await db.transaction(tx=>tx.query('UPDATE services SET is_demo=true WHERE id=$1',[demo.service]));
  try{
    const b=await hold();
    await assert.rejects(pay.initiate(passenger,b.id,{},randomUUID()),{code:'FORBIDDEN'},
      'a TEST booking must never reach a real provider');
  } finally {
    await db.transaction(tx=>tx.query('UPDATE services SET is_demo=false WHERE id=$1',[demo.service]));
  }
});
