import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { seedTestProfiles } from '@leroutier/database/test-profiles';
import { TEST } from '@leroutier/database/test-transport';
import { tickets } from '@leroutier/database/tickets';
import { parcels } from '@leroutier/database/parcels';
import { notificationPolicies } from '@leroutier/database/notifications';
import { createApi } from '../src/app.js';

const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),sessions={};
let api,seeded;
const call=async(profile,path,body=undefined,key=undefined)=>{
  const response=await api(new Request('http://localhost/api/v1'+path,{method:body===undefined?'GET':'POST',
    headers:{'content-type':'application/json',...(profile?{authorization:'Bearer '+sessions[profile].token}:{}),...(key?{'idempotency-key':key}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {status:response.status,...await response.json()};
};
before(async()=>{
  await migrate(db);seeded=await seedTestProfiles(db);api=createApi(db,config);
  for(const profile of ['passenger','owner-driver','company-driver','convoyeur','company-ops','platform-ops']) {
    const result=await call(null,'/auth/demo',{profile});assert.equal(result.status,200);sessions[profile]=result.data;
  }
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});

test('six TEST profiles have the intended identities, scoped services and no production shortcut',async()=>{
  for(const [profile,role] of [['passenger','passenger'],['owner-driver','driver'],['company-driver','driver'],['convoyeur','convoyeur'],['company-ops','ops'],['platform-ops','ops']]) {
    const me=await call(profile,'/me');assert.equal(me.data.role,role);assert.equal(me.data.is_demo,true);
  }
  assert.equal(sessions['owner-driver'].user.owner_user_id,sessions['owner-driver'].user.id);
  assert.equal(sessions['company-driver'].user.operator_type,'company');
  assert.equal(sessions['platform-ops'].user.operator_id,null);
  for(const profile of ['owner-driver','company-driver','convoyeur']) assert.equal((await call(profile,'/driver/service')).status,200);
  for(const [profile,path] of [['passenger','/driver/service'],['passenger','/ops/fleet'],['company-driver','/ops/fleet'],['company-driver','/ops/health'],['company-ops','/ops/health']]) assert.equal((await call(profile,path)).status,403);
  for(const profile of ['company-driver','convoyeur']) {
    for(const path of ['/operator/settlements','/operator/payouts']) assert.equal((await call(profile,path)).status,403);
  }
  assert.equal((await call('convoyeur',`/services/${TEST.service2}/advance`,{sequence:1})).status,403);
  assert.equal((await call('platform-ops','/ops/health')).status,200);
  assert.equal((await call(null,'/auth/demo',{profile:'arbitrary-admin'})).status,400);
  const deployed=createApi(db,{...config,demoLogin:false});
  assert.equal((await deployed(new Request('http://localhost/api/v1/auth/demo',{method:'POST',body:JSON.stringify({profile:'platform-ops'})}))).status,404);
  assert.deepEqual((await seedTestProfiles(db)).bookings,seeded.bookings,'reseed preserves the inspection journeys');
});

test('ticket QR and manual code enforce service, stop, assignment, duplicate and offline replay checks',async()=>{
  const credential=await tickets(db).issue(sessions.passenger.user,seeded.bookings[1]);
  const input={code:credential.token,serviceId:TEST.service2,stopSequence:0};
  assert.equal((await call('company-driver','/tickets/verify',input)).data.valid,true);
  assert.equal((await call('company-driver','/tickets/verify',{...input,code:credential.manualCode})).data.valid,true);
  assert.equal((await call('owner-driver','/tickets/verify',{...input,serviceId:TEST.service1})).error.code,'WRONG_SERVICE');
  assert.equal((await call('company-driver','/tickets/verify',{...input,stopSequence:1})).error.code,'WRONG_STOP');
  assert.equal((await call('owner-driver','/tickets/verify',input)).status,403);
  const action={type:'board',payload:input},key=randomUUID();
  assert.equal((await call('company-driver','/driver/actions',action,key)).data.status,'boarded');
  assert.equal((await call('company-driver','/driver/actions',action,key)).data.status,'boarded');
  assert.equal((await call('company-driver','/tickets/verify',input)).error.code,'ALREADY_BOARDED');
  assert.equal((await call('company-driver','/driver/actions',action,randomUUID())).status,409);
});

test('assigned convoyeur handles phone QR and manual parcels; pickup needs a separate code',async()=>{
  const cargo=parcels(db),crew=sessions.convoyeur.user,ops=sessions['company-ops'].user;
  const item=(await cargo.listDriver(crew))[0];assert.ok(item);
  const label=await cargo.label(sessions.passenger.user,item.id);
  await assert.rejects(cargo.scan(sessions.passenger.user,item.id,{kind:'loaded'},randomUUID()),{code:'FORBIDDEN'});
  assert.equal((await cargo.lookupDriver(crew,label.token)).id,item.id);
  assert.equal((await cargo.lookupDriver(crew,item.trackingNumber)).id,item.id);
  await assert.rejects(cargo.lookupDriver(sessions['owner-driver'].user,label.token),{code:'NOT_FOUND'});
  const key=randomUUID();await cargo.scan(crew,item.id,{kind:'loaded'},key);
  await cargo.exception(crew,item.id,{kind:'other',description:'TEST — étiquette à vérifier'});
  await cargo.scan(crew,item.id,{kind:'loaded'},key);
  await cargo.scan(crew,item.id,{kind:'departed'},randomUUID());
  await cargo.scan(crew,item.id,{kind:'arrived'},randomUUID());
  await assert.rejects(cargo.ready(crew,item.id),{code:'FORBIDDEN'});
  await cargo.ready(ops,item.id);
  const pickup=await cargo.issuePickupCode(ops,item.id);
  await assert.rejects(cargo.collect(sessions['company-driver'].user,item.id,{labelToken:label.token}),{code:'INVALID_PICKUP'});
  assert.equal((await cargo.collect(sessions['company-driver'].user,item.id,{code:pickup.code,receiverName:'TEST Destinataire'})).status,'collected');
  await assert.rejects(cargo.collect(sessions['company-driver'].user,item.id,{code:pickup.code}),{code:'INVALID_TRANSITION'});
  const publicData=JSON.stringify(await cargo.publicTracking(item.trackingNumber));
  for(const privateValue of ['TEST Destinataire','TEST Expéditeur','+00000000001',pickup.code,label.token]) assert.equal(publicData.includes(privateValue),false);
  await db.transaction(tx=>tx.query('UPDATE service_assignments SET convoyeur_id=NULL WHERE service_id=$1',[TEST.service2]));
  await assert.rejects(cargo.lookupDriver(crew,item.trackingNumber),{code:'NOT_FOUND'});
  await assert.rejects(cargo.scan(crew,item.id,{kind:'arrived'},randomUUID()),{code:'FORBIDDEN'});
});

test('TEST parcel payments cannot credit settlements or Fare Intelligence; party notices suppress external delivery',async()=>{
  const cargo=parcels(db),ops=sessions['platform-ops'].user;
  const item=(await cargo.listMine(sessions.passenger.user))[0];
  await cargo.recordPayment(ops,item.id,{provider:'cash',reference:'TEST-only',amountMinor:item.priceMinor},randomUUID());
  const policies=notificationPolicies(db);
  await db.transaction(async tx=>{
    for(const table of ['operator_settlements','fare_observations']) assert.equal((await tx.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
    for(const event of (await tx.query("SELECT * FROM outbox WHERE event_type LIKE 'parcel.%'")).rows) await policies.dispatchEvent(tx,event);
    const contacts=(await tx.query('SELECT DISTINCT contact FROM notifications WHERE contact IS NOT NULL')).rows.map(r=>r.contact);
    assert.ok(contacts.includes('+00000000001'));assert.ok(contacts.includes('+00000000002'));
    assert.equal((await tx.query("SELECT count(*)::int AS n FROM notification_deliveries WHERE channel<>'in_app' AND status<>'suppressed'")).rows[0].n,0);
  });
});

test('only assigned drivers can start and complete services, after final stop, passengers and cargo are resolved',async()=>{
  const path=`/services/${TEST.service1}/status`;
  assert.equal((await call('convoyeur',path,{status:'completed'})).status,403);
  assert.equal((await call('company-driver',path,{status:'completed'})).status,403);
  assert.equal((await call('owner-driver',path,{status:'cancelled'})).status,403);
  assert.equal((await call('owner-driver',path,{status:'completed'})).error.code,'INVALID_STOP');
  assert.equal((await call('convoyeur',`/services/${TEST.service2}/positions`,{latitude:6.36,longitude:2.43})).status,403);
  assert.equal((await call('owner-driver',`/services/${TEST.service1}/advance`,{sequence:1})).status,200);
  assert.equal((await call('owner-driver',path,{status:'completed'})).error.code,'ACTIVE_BOOKINGS');
  assert.equal((await call('passenger',`/bookings/${seeded.bookings[0]}/cancel`,{})).status,200);
  assert.equal((await call('owner-driver',path,{status:'completed'})).error.code,'ACTIVE_PARCELS');
  const cargo=parcels(db),driver=sessions['owner-driver'].user;
  const item=(await cargo.listDriver(driver))[0];
  for(const kind of ['loaded','departed','arrived']) await cargo.scan(driver,item.id,{kind},randomUUID());
  assert.equal((await call('owner-driver',path,{status:'completed'})).data.status,'completed');
  assert.equal((await call('owner-driver',path,{status:'active'})).status,403,'the ended assignment grants no further access');
});
