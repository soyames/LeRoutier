import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { seed,demo } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { transport } from '../src/transport.js';
import { payments } from '../src/payments.js';
import { tickets } from '../src/tickets.js';
import { driverAction } from '../src/driver-actions.js';
import { createApi } from '../../../services/api/src/app.js';
const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),d=transport(db),ticket=tickets(db);
const passenger={id:demo.passenger,role:'passenger'},driver={id:demo.driver,role:'driver'},ops={id:demo.ops,role:'ops',operator_id:demo.operator};
const secret=randomBytes(32).toString('hex');
// Local fixture gateway: same verified-event contract as the production
// adapter, with a deliberately generic HMAC scheme kept inside this test.
const signed={verifyEvent:async(raw,headers)=>{
  const stamp=headers.get('x-payment-timestamp'),signature=headers.get('x-payment-signature');
  if(!/^\d{10}$/.test(stamp||'') || Math.abs(Date.now()/1000-Number(stamp))>300 || !/^[a-f0-9]{64}$/i.test(signature||''))throw Object.assign(new Error(),{code:'INVALID_WEBHOOK'});
  const expected=createHmac('sha256',secret).update(stamp+'.'+raw).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new Error('invalid');
  return JSON.parse(raw);
}};
const results=new Map();
const adapter={name:'fixture-gateway',verifyEvent:signed.verifyEvent,
  async initiate(input){results.set(input.paymentId,{paymentId:input.paymentId,amountMinor:input.amountMinor,currency:input.currency,status:'pending',eventId:randomUUID(),reference:'fixture-'+input.paymentId});return {reference:'fixture-'+input.paymentId};},
  async reconcilePayment(p){return results.get(p.id);},
};
const pay=payments(db,adapter);
let api,sessions;
const hold=()=>d.hold(passenger,{serviceId:demo.service,origin:0,destination:1},randomUUID());
async function intent(){const b=await hold();return {b,p:await pay.initiate(passenger,b.id,{},randomUUID())};}
async function webhook(event){const raw=JSON.stringify({...event,kind:'payment'}),stamp=String(Math.floor(Date.now()/1000));return pay.webhook(adapter.name,raw,new Headers({'x-payment-timestamp':stamp,'x-payment-signature':createHmac('sha256',secret).update(stamp+'.'+raw).digest('hex')}));}
async function paid(){const {b,p}=await intent();await webhook({...results.get(p.id),status:'succeeded'});return {b,p};}
async function issued(){const {b,p}=await paid();return {b,p,t:await ticket.issue(passenger,b.id)};}
const verify=t=>ticket.verify(driver,{serviceId:demo.service,stopSequence:0,code:t.token});
before(async()=>{await migrate(db);await seed(db);api=createApi(db,config,undefined,/** @type {any} */(adapter));sessions={};for(const role of ['passenger','driver','ops']){const r=await api(new Request('http://localhost/api/v1/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})}));sessions[role]=(await r.json()).data.token;}});
beforeEach(async()=>{await db.transaction(async tx=>{await tx.query('DELETE FROM booking_segments');await tx.query("UPDATE bookings SET status='cancelled'");await tx.query("UPDATE services SET current_sequence=0,status='active'");});});
after(async()=>{try{await db.transaction(tx=>tx.query(`DROP SCHEMA "${db.schema}" CASCADE`));}finally{await db.close();}});

test('payment intent uses server amount and is idempotent',async()=>{const b=await hold(),key=randomUUID(),p=await pay.initiate(passenger,b.id,{},key);assert.equal(p.amountMinor,2500);assert.equal(p.status,'pending');assert.equal((await pay.initiate(passenger,b.id,{},key)).id,p.id);assert.equal((await d.booking(passenger,b.id)).status,'held');});
test('trusted payment success confirms atomically',async()=>{const {b}=await paid();assert.equal((await d.booking(passenger,b.id)).status,'confirmed');});
test('failed and cancelled payments never confirm booking',async()=>{for(const status of ['failed','cancelled']){const {b,p}=await intent();await webhook({...results.get(p.id),status});assert.equal((await d.booking(passenger,b.id)).status,'held');}});
test('webhook replay and concurrent delivery record one event',async()=>{const {b,p}=await intent(),event={...results.get(p.id),status:'succeeded'};await Promise.all([webhook(event),webhook(event)]);const n=await db.transaction(async tx=>(await tx.query('SELECT count(*)::integer AS n FROM payment_events WHERE payment_id=$1',[p.id])).rows[0].n);assert.equal(n,1);assert.equal((await d.booking(passenger,b.id)).status,'confirmed');});
test('amount and currency mismatches are rejected',async()=>{const {b,p}=await intent();for(const change of [{amountMinor:1},{currency:'USD'}])await assert.rejects(webhook({...results.get(p.id),status:'succeeded',...change}));assert.equal((await d.booking(passenger,b.id)).status,'held');});
test('frontend amount and status tampering are rejected',async()=>{const b=await hold();await assert.rejects(pay.initiate(passenger,b.id,{amountMinor:1,status:'succeeded'},randomUUID()),{code:'INVALID_PAYMENT'});});
test('payment ownership and production unavailability are enforced',async()=>{const b=await hold();await assert.rejects(pay.initiate({...passenger,id:randomUUID()},b.id,{},randomUUID()),{code:'FORBIDDEN'});await assert.rejects(payments(db).initiate(passenger,b.id,{},randomUUID()),{code:'PAYMENT_UNAVAILABLE'});});
test('duplicate provider references cannot credit another booking',async()=>{const first=await paid(),second=await intent();await assert.rejects(webhook({...results.get(second.p.id),reference:results.get(first.p.id).reference,status:'succeeded'}));assert.equal((await d.booking(passenger,second.b.id)).status,'held');});
test('event identifier reused with altered state is rejected',async()=>{const {p}=await paid();await assert.rejects(webhook({...results.get(p.id),status:'failed'}),{code:'EVENT_CONFLICT'});});
test('late success records review without reviving expired hold',async()=>{const {b,p}=await intent();await db.transaction(tx=>tx.query("UPDATE bookings SET expires_at=now()-interval '1 minute' WHERE id=$1",[b.id]));const result=await webhook({...results.get(p.id),status:'succeeded'});assert.equal(result.reconciliation,'review');assert.equal((await d.booking(passenger,b.id)).status,'expired');});
test('refund invalidates confirmed ticket and releases capacity',async()=>{const {b,p,t}=await issued();await webhook({...results.get(p.id),eventId:randomUUID(),status:'refunded'});assert.equal((await d.booking(passenger,b.id)).status,'cancelled');await assert.rejects(verify(t));});
test('reconciliation queries trusted adapter instead of client status',async()=>{const {b,p}=await intent();results.set(p.id,{...results.get(p.id),status:'succeeded'});await pay.reconcile(passenger,p.id);assert.equal((await d.booking(passenger,b.id)).status,'confirmed');});
test('authorized manual reconciliation confirms but passengers cannot invoke it',async()=>{const b=await hold(),input={provider:'cash',reference:randomUUID(),amountMinor:2500,currency:'XOF'};await assert.rejects(pay.manual(passenger,b.id,input,randomUUID()),{code:'FORBIDDEN'});await pay.manual(ops,b.id,input,randomUUID());assert.equal((await d.booking(passenger,b.id)).status,'confirmed');});
test('QR issuance stores digests only and no personal payload',async()=>{const {b,t}=await issued();assert.ok(t.token.startsWith('LRT1.'));assert.ok(!t.token.includes(b.id));const stored=await db.transaction(async tx=>(await tx.query('SELECT * FROM ticket_credentials WHERE booking_id=$1',[b.id])).rows[0]);assert.equal(JSON.stringify(stored).includes(t.token),false);assert.equal(JSON.stringify(stored).includes(t.manualCode),false);});
test('valid QR and manual code verify the same ticket',async()=>{const {b,t}=await issued();assert.equal((await verify(t)).bookingId,b.id);assert.equal((await ticket.verify(driver,{serviceId:demo.service,stopSequence:0,code:t.manualCode.toLowerCase()})).bookingId,b.id);});
test('forged QR and expired credential are rejected',async()=>{const {b,t}=await issued();await assert.rejects(verify({...t,token:t.token+'x'}));await db.transaction(tx=>tx.query("UPDATE ticket_credentials SET expires_at=now()-interval '1 minute' WHERE booking_id=$1",[b.id]));await assert.rejects(verify(t));});
test('credential rotation revokes previous code',async()=>{const {b,t}=await issued(),next=await ticket.issue(passenger,b.id);assert.equal(next.version,t.version+1);await assert.rejects(verify(t));assert.equal((await verify(next)).valid,true);});
test('wrong service, wrong stop and unassigned driver reject QR',async()=>{const {t}=await issued();await assert.rejects(ticket.verify(driver,{serviceId:randomUUID(),stopSequence:0,code:t.token}));await assert.rejects(ticket.verify(driver,{serviceId:demo.service,stopSequence:1,code:t.token}),{code:'WRONG_STOP'});await assert.rejects(ticket.verify({...driver,id:randomUUID()},{serviceId:demo.service,stopSequence:0,code:t.token}),{code:'FORBIDDEN'});});
test('already boarded QR is rejected while same action key safely replays',async()=>{const {b,t}=await issued(),key=randomUUID(),input={type:'board',payload:{serviceId:demo.service,stopSequence:0,code:t.token}};await driverAction(db,driver,input,key);await assert.rejects(verify(t),{code:'ALREADY_BOARDED'});await d.advance(driver,demo.service,1);assert.equal((await driverAction(db,driver,input,key)).status,'boarded');const n=await db.transaction(async tx=>(await tx.query('SELECT count(*)::integer AS n FROM boarding_events WHERE booking_id=$1',[b.id])).rows[0].n);assert.equal(n,1);});
test('cancelled and unpaid bookings cannot produce valid QR',async()=>{const unpaid=await hold();await assert.rejects(ticket.issue(passenger,unpaid.id));const {b,t}=await issued();await d.transition(passenger,b.id,'cancel');await assert.rejects(verify(t));await assert.rejects(ticket.issue(passenger,b.id));});
test('offline action cannot change roles, stop state or passenger identity',async()=>{const {b}=await paid();for(const extra of [{role:'ops'},{status:'boarded'},{passengerId:randomUUID()}])await assert.rejects(driverAction(db,driver,{type:'board',payload:{bookingId:b.id,serviceId:demo.service,stopSequence:0,...extra}},randomUUID()),{code:'INVALID_ACTION'});await assert.rejects(driverAction(db,passenger,{type:'board',payload:{bookingId:b.id,serviceId:demo.service,stopSequence:0}},randomUUID()),{code:'FORBIDDEN'});});
test('stale queued boarding conflicts after service advances',async()=>{const {b}=await paid();await d.advance(driver,demo.service,1);await assert.rejects(driverAction(db,driver,{type:'board',payload:{bookingId:b.id,serviceId:demo.service,stopSequence:0}},randomUUID()),{code:'WRONG_STOP'});});
test('queued alighting and incident retries create one event',async()=>{const {b}=await paid();await d.transition(driver,b.id,'board',0);await d.advance(driver,demo.service,1);for(const input of [{type:'alight',payload:{bookingId:b.id,serviceId:demo.service,stopSequence:1}},{type:'incident',payload:{serviceId:demo.service,kind:'other',severity:'medium',description:'Offline fixture incident'}}]){const key=randomUUID(),first=await driverAction(db,driver,input,key);assert.equal((await driverAction(db,driver,input,key)).id,first.id);await assert.rejects(driverAction(db,driver,{...input,payload:{...input.payload,serviceId:demo.service,description:'changed'}},key));}});
test('API exposes payment, QR and driver action contracts',async()=>{const b=await hold();async function call(path,body,role='passenger'){const r=await api(new Request('http://localhost'+path,{method:'POST',headers:{authorization:'Bearer '+sessions[role],'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(body)}));return {status:r.status,...await r.json()};}const p=await call(`/api/v1/bookings/${b.id}/payment-intents`,{});assert.equal(p.status,200);await webhook({...results.get(p.data.id),status:'succeeded'});const qr=await call(`/api/v1/bookings/${b.id}/ticket`,{});assert.equal(qr.status,200);assert.equal((await call('/api/v1/tickets/verify',{code:qr.data.token,serviceId:demo.service,stopSequence:0},'driver')).data.valid,true);assert.equal((await call('/api/v1/driver/actions',{type:'board',payload:{code:qr.data.token,serviceId:demo.service,stopSequence:0}},'driver')).data.status,'boarded');});
