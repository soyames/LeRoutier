import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo, demoId } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { transport } from '../src/transport.js';
import { payments } from '../src/payments.js';
import { payouts } from '../src/payouts.js';
import { recovery } from '../src/recovery.js';
import { parcels } from '../src/parcels.js';
import { recordIncident } from '../src/driver-actions.js';
import { bootstrap, createActions, createWorkflowEngine } from '@leroutier/agents';
import { createApi } from '../../../services/api/src/app.js';

const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),domain=transport(db),parcel=parcels(db);
const passenger={id:demo.passenger,role:'passenger'},driver={id:demo.driver,role:'driver'},ops={id:demo.ops,role:'ops',operator_id:demo.operator};
const actions=createActions({db,domain,payments:payments(db),payouts:payouts(db),recovery:recovery(db),parcels:parcel});
const engine=createWorkflowEngine({db,actions});
let api,sessions,otherOperator,otherOps,platformToken;
const one=async(sql,args=[])=>(await db.transaction(async tx=>(await tx.query(sql,args)).rows[0]));
const originStop=demoId(200),destinationStop=demoId(201);
const valid=overrides=>({senderName:'Awa Sender',senderPhone:'+229 61 00 00 01',receiverName:'Kofi Receiver',receiverPhone:'+229 61 00 00 02',
  originStopId:originStop,destinationStopId:destinationStop,category:'documents',...overrides});
async function created(overrides={}){return parcel.create(passenger,valid(overrides),randomUUID());}
async function readyParcel(){
  const p=await created();
  const accepted=await parcel.accept(ops,p.id);
  await parcel.assign(ops,p.id,{serviceId:demo.service});
  await parcel.scan(driver,p.id,{kind:'loaded'},randomUUID());
  await parcel.scan(driver,p.id,{kind:'departed'},randomUUID());
  await parcel.scan(driver,p.id,{kind:'arrived'},randomUUID());
  return {p:await parcel.ready(ops,p.id),accepted};
}
before(async()=>{
  await migrate(db);await seed(db);
  // Second operator + Ops user for cross-operator tests (fixtures).
  otherOperator=randomUUID();
  await db.transaction(async tx=>{
    await tx.query("INSERT INTO operators(id,name) VALUES($1,'Other Operator')",[otherOperator]);
    const opsId=randomUUID();
    await tx.query('INSERT INTO users(id,display_name,role,operator_id) VALUES($1,$2,$3,$4)',[opsId,'Other Ops','ops',otherOperator]);
    otherOps={id:opsId,role:'ops',operator_id:otherOperator};
  });
  api=createApi(db,config);
  sessions={};
  for(const role of ['passenger','driver','ops']){const r=await api(new Request('http://localhost/api/v1/auth/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role})}));sessions[role]=(await r.json()).data.token;}
  platformToken='lragt_'+randomBytes(32).toString('base64url');
  await bootstrap(db,{name:'parcel-agent',token:platformToken,scopes:['parcel.read','parcel.manage','parcel.notify','alert.create','payment.reconcile']});
});
beforeEach(async()=>{
  await db.transaction(async tx=>{await tx.query('DELETE FROM booking_segments');await tx.query("UPDATE bookings SET status='cancelled'");
    await tx.query('DELETE FROM payment_events');await tx.query('DELETE FROM payments');await tx.query('DELETE FROM payout_events');await tx.query('DELETE FROM driver_earnings');
    await tx.query('DELETE FROM payout_requests');await tx.query('DELETE FROM payout_destinations');await tx.query('DELETE FROM parcel_proof_of_delivery');
    await tx.query('DELETE FROM parcel_pickup_codes');await tx.query('DELETE FROM parcel_exceptions');await tx.query('DELETE FROM parcel_payments');
    await tx.query('DELETE FROM parcel_custody');await tx.query('DELETE FROM parcel_service_assignments');await tx.query('DELETE FROM parcel_events');
    await tx.query('DELETE FROM parcel_labels');await tx.query('DELETE FROM parcel_parties');await tx.query('DELETE FROM parcels');
    await tx.query('DELETE FROM agent_action_receipts');await tx.query('DELETE FROM workflow_approvals');await tx.query('DELETE FROM workflow_runs');
    await tx.query('DELETE FROM outbox');await tx.query("UPDATE services SET current_sequence=0,status='active'");
    await tx.query('DELETE FROM parcel_rate_rules');await tx.query('INSERT INTO parcel_rate_rules(operator_id,base_minor,per_kg_minor,declared_value_bp) VALUES($1,1000,500,0)',[demo.operator]);});
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});
const agentRequest=(agentToken,path,method='GET',body=undefined)=>
  new Request('http://localhost/api/v1'+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+agentToken},...(body===undefined?{}:{body:JSON.stringify(body)})});

test('parcel creation assigns a unique tracking number and validates parties',async()=>{
  const p=await created();
  assert.match(p.trackingNumber,/^LRP-[0-9A-F]{8}$/);
  assert.equal(p.status,'created');
  assert.equal(p.priceMinor,1000,'demo rate rule base applies');
  assert.equal(p.parties.sender.name,'Awa Sender');
  assert.equal(p.parties.receiver.phone,'+229 61 00 00 02');
  const second=await created();
  assert.notEqual(second.trackingNumber,p.trackingNumber);
  await assert.rejects(created({senderName:'x'}),{code:'INVALID_PARCEL'});
  await assert.rejects(created({receiverPhone:'abc'}),{code:'INVALID_PARCEL'});
  await assert.rejects(created({originStopId:p.destinationStopId,destinationStopId:p.originStopId}),{code:'INVALID_JOURNEY'});
  await assert.rejects(created({category:'prohibited_thing'}),{code:'RESTRICTED_CATEGORY'});
});
test('pricing fails closed without configured rate rules',async()=>{
  await db.transaction(async tx=>tx.query('DELETE FROM parcel_rate_rules'));
  await assert.rejects(created(),{code:'PRICING_UNAVAILABLE'});
});
test('label QR identifies the parcel token and the barcode is the tracking number',async()=>{
  const p=await created();
  const label=await parcel.label(passenger,p.id);
  assert.ok(label.token.startsWith('LRP1.'));
  assert.equal(label.barcode,p.trackingNumber);
  const stored=await one('SELECT token_hash FROM parcel_labels WHERE parcel_id=$1',[p.id]);
  assert.equal(JSON.stringify(stored).includes(label.token),false,'only digests are stored');
  const rotated=await parcel.label(passenger,p.id);
  assert.equal(rotated.version,2);
  assert.notEqual(rotated.token,label.token);
});
test('assigned driver resolves phone QR and handwritten LRP reference without party data',async()=>{
  const p=await created();
  await parcel.accept(ops,p.id);
  await parcel.assign(ops,p.id,{serviceId:demo.service});
  const label=await parcel.label(passenger,p.id);
  const byReference=await parcel.lookupDriver(driver,p.trackingNumber.toLowerCase());
  assert.equal(byReference.id,p.id);
  assert.equal(byReference.trackingNumber,p.trackingNumber);
  assert.ok(byReference.originCity);
  assert.ok(byReference.destinationCity);
  assert.equal(Object.hasOwn(byReference,'parties'),false);
  const byPhoneQr=await parcel.lookupDriver(driver,label.token);
  assert.equal(byPhoneQr.id,p.id);
  await assert.rejects(parcel.lookupDriver({id:randomUUID(),role:'driver'},p.trackingNumber),{code:'NOT_FOUND'});
  await assert.rejects(parcel.lookupDriver(driver,'LRP-00000000'),{code:'NOT_FOUND'});
});
test('full lifecycle: accept, assign, load, depart, arrive, ready and collect with code',async()=>{
  const {p,accepted}=await readyParcel();
  assert.equal(accepted.status,'accepted');
  assert.equal(p.status,'ready_for_pickup');
  const custody=await one('SELECT * FROM parcel_custody WHERE parcel_id=$1',[p.id]);
  assert.equal(custody.holder_kind,'station');
  const {code}=await parcel.issuePickupCode(ops,p.id);
  assert.match(code,/^\d{6}$/);
  const label=await parcel.label(passenger,p.id);
  const collected=await parcel.collect(ops,p.id,{code,receiverName:'Kofi Receiver',labelToken:label.token});
  assert.equal(collected.status,'collected');
  const custodyAfter=await one('SELECT * FROM parcel_custody WHERE parcel_id=$1',[p.id]);
  assert.equal(custodyAfter.holder_kind,'receiver');
  const proof=await one('SELECT receiver_name FROM parcel_proof_of_delivery WHERE parcel_id=$1',[p.id]);
  assert.equal(proof.receiver_name,'Kofi Receiver');
  const events=(await parcel.events(ops,p.id)).map(e=>e.kind);
  for(const kind of ['created','accepted','manifested','loaded','departed','arrived','ready_for_pickup','pickup_code_issued','collected'])assert.ok(events.includes(kind),kind);
});
test('invalid, expired, reused and forged pickup codes are rejected',async()=>{
  const {p}=await readyParcel();
  await parcel.issuePickupCode(ops,p.id);
  await assert.rejects(parcel.collect(ops,p.id,{code:'000000',receiverName:'X'}),{code:'INVALID_PICKUP'});
  const second=await readyParcel();
  const issue=await parcel.issuePickupCode(ops,second.p.id);
  await assert.rejects(parcel.collect(ops,second.p.id,{code:issue.code,labelToken:'LRP1.forged'}),{code:'INVALID_PICKUP'});
  await parcel.collect(ops,second.p.id,{code:issue.code,receiverName:'Receiver One'});
  await assert.rejects(parcel.collect(ops,second.p.id,{code:issue.code,receiverName:'Receiver Two'}),{code:'INVALID_TRANSITION'});
  const third=await readyParcel();
  const issued=await parcel.issuePickupCode(ops,third.p.id);
  await db.transaction(async tx=>tx.query("UPDATE parcel_pickup_codes SET expires_at=now()-interval '1 minute' WHERE parcel_id=$1 AND used_at IS NULL",[third.p.id]));
  await assert.rejects(parcel.collect(ops,third.p.id,{code:issued.code,receiverName:'X'}),{code:'INVALID_PICKUP'});
});
test('duplicate and conflicting scans are idempotent and safe',async()=>{
  const p=await created();
  await parcel.accept(ops,p.id);
  await parcel.assign(ops,p.id,{serviceId:demo.service});
  const key=randomUUID();
  await parcel.scan(driver,p.id,{kind:'loaded'},key);
  const replay=await parcel.scan(driver,p.id,{kind:'loaded'},key);
  assert.equal(replay.status,'loaded');
  const count=(await one('SELECT count(*)::integer AS n FROM parcel_events WHERE parcel_id=$1 AND kind=$2',[p.id,'loaded'])).n;
  assert.equal(count,1,'offline replays never duplicate custody events');
  await assert.rejects(parcel.scan(driver,p.id,{kind:'loaded'},randomUUID()),{code:'INVALID_TRANSITION'});
  await assert.rejects(parcel.scan(driver,p.id,{kind:'arrived'},key),{code:'INVALID_TRANSITION'});
});
test('public tracking exposes only safe fields',async()=>{
  const p=await created();
  await parcel.accept(ops,p.id);
  await parcel.assign(ops,p.id,{serviceId:demo.service});
  await parcel.scan(driver,p.id,{kind:'loaded'},randomUUID());
  const tracking=await parcel.publicTracking(p.trackingNumber);
  assert.equal(tracking.trackingNumber,p.trackingNumber);
  assert.equal(tracking.status,'loaded');
  assert.equal(tracking.origin.city,'Cotonou');
  assert.equal(tracking.pickupReady,false);
  const serialized=JSON.stringify(tracking);
  assert.equal(serialized.includes('Awa Sender'),false);
  assert.equal(serialized.includes('+229'),false);
  assert.equal(serialized.includes('1000'),false,'no payment data');
  assert.equal(serialized.includes('notes'),false);
  await assert.rejects(parcel.publicTracking('LRP-00000000'),{code:'NOT_FOUND'});
});
test('vehicle-derived tracking shows the latest trusted position explicitly derived',async()=>{
  const p=await created();
  await parcel.accept(ops,p.id);
  await parcel.assign(ops,p.id,{serviceId:demo.service});
  await parcel.scan(driver,p.id,{kind:'loaded'},randomUUID());
  await db.transaction(async tx=>{await tx.query(`INSERT INTO vehicle_positions(service_id,vehicle_id,actor_id,latitude,longitude,observed_at)
    VALUES($1,$2,$3,7.18,2.11,now())`,[demo.service,demo.vehicle,demo.driver]);});
  const tracking=await parcel.publicTracking(p.trackingNumber);
  assert.equal(tracking.location.derivedFromVehicle,true);
  assert.equal(tracking.location.latitude,7.18);
});
test('damaged exception moves the parcel to damaged and records an open exception',async()=>{
  const p=await created();
  await parcel.accept(ops,p.id);
  await parcel.assign(ops,p.id,{serviceId:demo.service});
  await parcel.scan(driver,p.id,{kind:'loaded'},randomUUID());
  const damaged=await parcel.exception(driver,p.id,{kind:'damaged',description:'Carton écrasé au chargement.'});
  assert.equal(damaged.status,'damaged');
  const row=await one('SELECT * FROM parcel_exceptions WHERE parcel_id=$1',[p.id]);
  assert.equal(row.kind,'damaged');
  assert.equal(row.status,'open');
  await assert.rejects(parcel.scan(driver,p.id,{kind:'departed'},randomUUID()),{code:'INVALID_TRANSITION'});
});
test('cancellation is only allowed before loading and closes assignments',async()=>{
  const p=await created();
  const cancelled=await parcel.cancel(passenger,p.id);
  assert.equal(cancelled.status,'cancelled');
  const second=await created();
  await parcel.accept(ops,second.id);
  await parcel.assign(ops,second.id,{serviceId:demo.service});
  await parcel.scan(driver,second.id,{kind:'loaded'},randomUUID());
  await assert.rejects(parcel.cancel(passenger,second.id),{code:'INVALID_TRANSITION'});
});
test('sender cannot view another sender’s parcel; driver needs the right assignment',async()=>{
  const p=await created();
  await assert.rejects(parcel.get({id:randomUUID(),role:'passenger'},p.id),{code:'FORBIDDEN'});
  await assert.rejects(parcel.get(driver,p.id),{code:'FORBIDDEN'});
  await parcel.accept(ops,p.id);
  await parcel.assign(ops,p.id,{serviceId:demo.service});
  const view=await parcel.get(driver,p.id);
  assert.equal(view.trackingNumber,p.trackingNumber);
  assert.equal(view.parties,undefined,'drivers never see party details');
});
test('cross-operator parcel access is rejected',async()=>{
  const p=await created();
  await assert.rejects(parcel.get(otherOps,p.id),{code:'FORBIDDEN'});
  await assert.rejects(parcel.accept(otherOps,p.id),{code:'FORBIDDEN'});
  await assert.rejects(parcel.assign(otherOps,p.id,{serviceId:demo.service}),{code:'FORBIDDEN'});
});
test('parcel payment must match the configured price exactly',async()=>{
  const p=await created();
  await assert.rejects(parcel.recordPayment(ops,p.id,{provider:'cash',reference:'R-1',amountMinor:999},randomUUID()),{code:'INVALID_PAYMENT'});
  const payment=await parcel.recordPayment(ops,p.id,{provider:'cash',reference:'R-1',amountMinor:1000},randomUUID());
  assert.equal(payment.status,'succeeded');
  const passengers=await one('SELECT count(*)::integer AS n FROM payments WHERE booking_id IS NOT NULL');
  assert.equal(passengers.n,0,'parcel accounting stays separate from passenger fares');
});
test('parcel mutations are audited and emit outbox events',async()=>{
  const p=await created();
  const audit=await one("SELECT count(*)::integer AS n FROM audit_events WHERE entity_id=$1",[p.id]);
  assert.ok(audit.n>=1);
  const outbox=await one("SELECT count(*)::integer AS n FROM outbox WHERE event_type='parcel.created'");
  assert.ok(outbox.n>=1);
});
test('agent parcel actions respect scopes and operator boundaries',async()=>{
  const r=await api(agentRequest(platformToken,'/agent/actions/parcel.inspect/run','POST',{}));
  assert.equal(r.status,200);
  const data=(await r.json()).data;
  assert.equal(data.status,'completed');
  assert.ok(Array.isArray(data.result));
  // Operator-bound principal cannot reach another operator's parcels.
  const boundToken='lragt_'+randomBytes(32).toString('base64url');
  await bootstrap(db,{name:'parcel-bound-agent',token:boundToken,scopes:['parcel.read'],operatorId:otherOperator});
  const bound=await api(agentRequest(boundToken,'/agent/actions/parcel.inspect/run','POST',{}));
  const boundData=(await bound.json()).data;
  assert.ok(Array.isArray(boundData.result));
  const p=await created();
  // Operator-bound principals can never mutate another operator's parcels.
  await assert.rejects(parcel.reassign({agent:{operatorId:otherOperator}},{parcelId:p.id,serviceId:demo.service}),{code:'FORBIDDEN'});
  const escalate=await api(agentRequest(platformToken,'/agent/actions/parcel.escalate/run','POST',{parcelId:p.id,reason:'probe'}));
  assert.equal(escalate.status,200);
  const alert=await one("SELECT * FROM outbox WHERE event_type='alert.created' AND payload->>'kind'='parcel'");
  assert.ok(alert);
});
test('parcel delay workflow detects parcels on a delayed service and marks them',async()=>{
  const p=await created();
  await parcel.accept(ops,p.id);
  await parcel.assign(ops,p.id,{serviceId:demo.service});
  await parcel.scan(driver,p.id,{kind:'loaded'},randomUUID());
  await parcel.scan(driver,p.id,{kind:'departed'},randomUUID());
  await recordIncident(db,driver,{serviceId:demo.service,kind:'delay',severity:'medium',description:'Retard parcellaire'});
  await db.transaction(async tx=>tx.query("INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('service.position',$1,$2)",[demo.service,JSON.stringify({serviceId:demo.service,observedAt:new Date().toISOString()})]));
  await engine.processOutbox();
  const delayed=await one("SELECT count(*)::integer AS n FROM parcel_events WHERE parcel_id=$1 AND kind='delayed'",[p.id]);
  assert.equal(delayed.n,1);
  const alert=await one("SELECT * FROM outbox WHERE event_type='alert.created' AND payload->>'kind'='delay'");
  assert.ok(alert,'Ops alert raised');
});
test('parcel breakdown workflow proposes reassignment and waits for Ops approval',async()=>{
  // Fixture: a second operable service for the same route (multi-service demo).
  const service2=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO services(id,route_id,operator_id,departure_at,status,capacity) VALUES($1,$2,$3,now()+interval '2 hours','scheduled',12)`,[service2,demo.route,demo.operator]);
    await tx.query('INSERT INTO service_stops(service_id,sequence,stop_id) SELECT $1,sequence,stop_id FROM route_stops WHERE route_id=$2',[service2,demo.route]);
    await tx.query('INSERT INTO service_segments(service_id,sequence,fare_minor) SELECT $1,sequence,fare_to_next FROM route_stops WHERE route_id=$2 AND sequence<3',[service2,demo.route]);
    await tx.query('INSERT INTO service_seats(service_id,seat_number) SELECT $1,generate_series(1,12)',[service2]);
    const v2=randomUUID(),d2=randomUUID();
    await tx.query("INSERT INTO vehicles(id,operator_id,registration,capacity) VALUES($1,$2,'DEMO-BUS-02',12)",[v2,demo.operator]);
    await tx.query('INSERT INTO users(id,display_name,role,operator_id,profile_completed_at) VALUES($1,$2,$3,$4,now())',[d2,'Driver Two','driver',demo.operator]);
    await tx.query('INSERT INTO driver_profiles(user_id,operator_id,license_reference) VALUES($1,$2,$3)',[d2,demo.operator,'LIC-2']);
    await tx.query('INSERT INTO service_assignments(service_id,vehicle_id,driver_id) VALUES($1,$2,$3)',[service2,v2,d2]);
  });
  const p=await created();
  await parcel.accept(ops,p.id);
  await parcel.assign(ops,p.id,{serviceId:demo.service});
  await parcel.scan(driver,p.id,{kind:'loaded'},randomUUID());
  await recordIncident(db,driver,{serviceId:demo.service,kind:'breakdown',severity:'high',description:'Panne avec colis'});
  await engine.processOutbox();
  const approval=(await engine.listApprovals(ops)).find(a=>a.action==='parcel.reassign');
  assert.ok(approval,'reassignment requires approval');
  const run=await engine.approve(ops,approval.id,'approved');
  assert.equal(run.status,'completed');
  const assignment=await one("SELECT * FROM parcel_service_assignments WHERE parcel_id=$1 ORDER BY created_at DESC LIMIT 1",[p.id]);
  assert.notEqual(assignment.service_id,demo.service,'reassigned to a replacement service');
  const custody=await one('SELECT service_id FROM parcel_custody WHERE parcel_id=$1',[p.id]);
  assert.equal(custody.service_id,assignment.service_id);
});
test('end-to-end parcel lifecycle through the versioned API',async()=>{
  async function call(path,method='GET',body=undefined,role='passenger',key=randomUUID()){
    const r=await api(new Request('http://localhost/api/v1'+path,{method,headers:{authorization:'Bearer '+sessions[role],'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    return {status:r.status,...await r.json()};
  }
  const quote=await call(`/parcels/quote?originStopId=${originStop}&destinationStopId=${destinationStop}&category=documents`);
  assert.equal(quote.status,200);
  const p=await call('/parcels','POST',valid());
  assert.equal(p.status,200);
  const id=p.data.id;
  assert.equal((await call(`/parcels/${id}/accept`,'POST',undefined,'ops')).status,200);
  assert.equal((await call(`/parcels/${id}/assign`,'POST',{serviceId:demo.service},'ops')).status,200);
  const label=await call(`/parcels/${id}/label`);
  assert.equal((await call(`/driver/parcels/lookup?code=${encodeURIComponent(p.data.trackingNumber)}`,'GET',undefined,'driver')).data.id,id);
  assert.equal((await call(`/driver/parcels/lookup?code=${encodeURIComponent(label.data.token)}`,'GET',undefined,'driver')).data.id,id);
  assert.equal((await call(`/parcels/${id}/scan`,'POST',{kind:'loaded'},'driver')).status,200);
  assert.equal((await call(`/parcels/${id}/scan`,'POST',{kind:'departed'},'driver')).status,200);
  assert.equal((await call(`/parcels/${id}/scan`,'POST',{kind:'arrived'},'driver')).status,200);
  assert.equal((await call(`/parcels/${id}/ready`,'POST',undefined,'ops')).status,200);
  const code=await call(`/parcels/${id}/pickup-code`,'POST',undefined,'ops');
  assert.match(code.data.code,/^\d{6}$/);
  assert.equal((await call(`/parcels/${id}/pickup`,'POST',{code:code.data.code,receiverName:'Kofi Receiver'},'ops')).status,200);
  const tracking=await call(`/public/parcel-tracking/${p.data.trackingNumber}`);
  assert.equal(tracking.data.status,'collected');
  assert.equal(JSON.stringify(tracking.data).includes('+229'),false);
});
