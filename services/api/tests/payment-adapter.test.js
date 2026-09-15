import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fedapayAdapter, verifyFedaPaySignature } from '../src/fedapay.js';

const secret='wh_sandbox_test_secret_placeholder_32chars';
function sign(raw,timestamp=Math.floor(Date.now()/1000),key=secret){
  return `t=${timestamp},s=${createHmac('sha256',key).update(`${timestamp}.${raw}`).digest('hex')}`;
}
const config=overrides=>({paymentProvider:'fedapay',production:false,
  fedapay:{environment:'sandbox',secretKey:'sk_sandbox_test_placeholder',payoutSecretKey:'pk_sandbox_test_placeholder',webhookSecret:secret},
  ...overrides});
const responses=[];
function httpFixture(){
  responses.length=0;
  return async(url,init)=>{
    const path=new URL(url).pathname,method=init?.method||'GET',body=init?.body?JSON.parse(init.body):undefined;
    responses.push({path,method,body});
    if(path==='/v1/transactions'&&method==='POST')return new Response(JSON.stringify({id:42,reference:'T-REF-42',status:'pending',amount:body.amount}),{status:201});
    if(path==='/v1/transactions/42/token'&&method==='POST')return new Response(JSON.stringify({token:'tok_123',url:'https://process.fedapay.com/tok_123'}),{status:200});
    if(path==='/v1/transactions/42'&&method==='GET')return new Response(JSON.stringify({id:42,reference:'T-REF-42',status:'approved',amount:2500,currency:{iso:'XOF'},updated_at:'2026-09-15T00:00:00Z'}),{status:200});
    if(path==='/v1/payouts'&&method==='POST')return new Response(JSON.stringify({id:77,reference:'P-77',status:'pending',amount:body.amount}),{status:201});
    if(path==='/v1/payouts/start'&&method==='PUT')return new Response(JSON.stringify([{id:77,reference:'P-77',status:'started',amount:2000}]),{status:200});
    if(path==='/v1/payouts/77'&&method==='GET')return new Response(JSON.stringify({id:77,reference:'P-77',status:'sent',amount:2000,currency:{iso:'XOF'},updated_at:'2026-09-15T00:00:00Z'}),{status:200});
    return new Response('{}',{status:404});
  };
}
const event=(type,entity)=>({id:123,type,entity});

test('adapter fails closed without FedaPay configuration',()=>{
  assert.equal(fedapayAdapter({paymentProvider:'',production:false,fedapay:{}}),null);
  assert.equal(fedapayAdapter({paymentProvider:'other',production:false,fedapay:{environment:'live',secretKey:'x',webhookSecret:secret}}),null);
  assert.equal(fedapayAdapter(config({fedapay:{environment:'sandbox',secretKey:'x'}})),null);
  assert.equal(fedapayAdapter(config({production:true})),null,'production must never fall back to sandbox');
  assert.equal(fedapayAdapter(config({production:true,fedapay:{environment:'live',secretKey:'sk_live_placeholder',payoutSecretKey:'pk_live_placeholder',webhookSecret:'wh_live_placeholder'}}))?.name,'fedapay');
});

test('initiate creates a transaction with LeRoutier metadata and returns a checkout link',async()=>{
  const adapter=fedapayAdapter(config(),httpFixture());
  const result=await adapter.initiate({paymentId:'00000000-0000-4000-8000-000000000001',bookingId:'00000000-0000-4000-8000-000000000002',amountMinor:2500,currency:'XOF',idempotencyKey:'key-0001'});
  assert.equal(result.reference,'T-REF-42');
  assert.match(result.checkoutUrl,/^https:\/\//);
  assert.equal(result.metadata.fedapayId,42);
  const create=responses.find(r=>r.path==='/v1/transactions');
  assert.equal(create.body.amount,2500);
  assert.equal(create.body.custom_metadata.app,'leroutier');
  assert.equal(create.body.custom_metadata.payment_id,'00000000-0000-4000-8000-000000000001');
  assert.equal(responses.some(r=>r.path==='/v1/transactions/42/token'),true);
});

test('webhook signature verifies exactly per the official FedaPay scheme',async()=>{
  const raw=JSON.stringify(event('transaction.approved',{status:'approved',amount:2500,currency:{iso:'XOF'},reference:'T-REF-42',id:42,custom_metadata:{app:'leroutier',payment_id:'00000000-0000-4000-8000-000000000001'}}));
  assert.equal(verifyFedaPaySignature(raw,sign(raw),secret),true);
  assert.throws(()=>verifyFedaPaySignature(raw,sign(raw,Math.floor(Date.now()/1000)-301),secret),/too old/);
  assert.throws(()=>verifyFedaPaySignature(raw,`t=${Math.floor(Date.now()/1000)},s=${'f'.repeat(64)}`,secret),/invalid/);
  assert.throws(()=>verifyFedaPaySignature(raw,sign(raw+' '),secret),/invalid/);
  assert.throws(()=>verifyFedaPaySignature(raw,sign(raw,undefined,'other-secret-32-chars-minimum!'),secret),/invalid/);
});

test('verified collection events map to payment events with strict correlation',async()=>{
  const adapter=fedapayAdapter(config(),httpFixture());
  const raw=JSON.stringify(event('transaction.approved',{status:'approved',amount:2500,currency:{iso:'XOF'},reference:'T-REF-42',id:42,custom_metadata:{app:'leroutier',payment_id:'00000000-0000-4000-8000-000000000001'}}));
  const mapped=await adapter.verifyEvent(raw,new Headers({'x-fedapay-signature':sign(raw)}));
  assert.equal(mapped.kind,'payment');
  assert.equal(mapped.status,'succeeded');
  assert.equal(/** @type {{paymentId?:string}} */(mapped).paymentId,'00000000-0000-4000-8000-000000000001');
  // Another product's transaction on the same account is safely ignored.
  const foreign=JSON.stringify(event('transaction.approved',{status:'approved',amount:999,currency:{iso:'XOF'},reference:'T-OTHER',id:99,custom_metadata:{app:'other-product'}}));
  assert.equal(await adapter.verifyEvent(foreign,new Headers({'x-fedapay-signature':sign(foreign)})),null);
  // Customer events are never processed.
  const customer=JSON.stringify(event('customer.created',{id:5}));
  assert.equal(await adapter.verifyEvent(customer,new Headers({'x-fedapay-signature':sign(customer)})),null);
  // Payout events map to payout kind.
  const payoutRaw=JSON.stringify(event('payout.sent',{status:'sent',amount:2000,currency:{iso:'XOF'},reference:'P-77',id:77,custom_metadata:{app:'leroutier',payout_request_id:'00000000-0000-4000-8000-000000000003'}}));
  const payoutEvent=await adapter.verifyEvent(payoutRaw,new Headers({'x-fedapay-signature':sign(payoutRaw)}));
  assert.equal(payoutEvent.kind,'payout');
  assert.equal(payoutEvent.status,'paid');
});

test('reconciliation fetches the trusted provider state',async()=>{
  const adapter=fedapayAdapter(config(),httpFixture());
  const event=await adapter.reconcilePayment({id:'00000000-0000-4000-8000-000000000001',provider_metadata:{fedapayId:42}});
  assert.equal(event.status,'succeeded');
  assert.equal(event.reference,'T-REF-42');
  assert.equal(event.amountMinor,2500);
  const payout=await adapter.reconcilePayout({id:'00000000-0000-4000-8000-000000000003',provider_metadata:{fedapayId:77}});
  assert.equal(payout.kind,'payout');
  assert.equal(payout.status,'paid');
});

test('payout creation requires its own key and starts the transfer',async()=>{
  const adapter=fedapayAdapter(config(),httpFixture());
  const result=await adapter.createPayout({payoutRequestId:'00000000-0000-4000-8000-000000000003',firstName:'Koffi',lastName:'Kodjo',phoneNumber:'61234567',country:'bj',amountMinor:2000,currency:'XOF',idempotencyKey:'p-1'});
  assert.equal(result.reference,'P-77');
  const create=responses.find(r=>r.path==='/v1/payouts');
  assert.equal(create.body.custom_metadata.app,'leroutier');
  assert.equal(create.body.mode,'mobile_money');
  assert.equal(responses.some(r=>r.path==='/v1/payouts/start'),true);
  const withoutKey=fedapayAdapter(config({fedapay:{environment:'sandbox',secretKey:'sk',webhookSecret:secret}}),httpFixture());
  await assert.rejects(withoutKey.createPayout({payoutRequestId:'00000000-0000-4000-8000-000000000003',firstName:'A',lastName:'B',phoneNumber:'61234567',country:'bj',amountMinor:2000,currency:'XOF',idempotencyKey:'p-2'}),{code:'PAYOUT_UNAVAILABLE'});
});
