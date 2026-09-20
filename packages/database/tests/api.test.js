import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { serverConfig } from '@leroutier/config';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo, demoId } from '../src/seed.js';
import { createApi } from '../../../services/api/src/app.js';

const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),api=createApi(db,config),sessions={};
async function call(path,method='GET',body=undefined,role='passenger',key=randomUUID()) {
  const response=await api(new Request('http://localhost'+path,{method,headers:{'content-type':'application/json','authorization':'Bearer '+(sessions[role]||''),'idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {status:response.status,...await response.json()};
}
before(async()=>{
  await migrate(db);await seed(db);
  await db.transaction(async tx => {
    await tx.query('UPDATE routes SET active=true, is_demo=false WHERE id=$1', [demo.route]);
    await tx.query('UPDATE services SET is_demo=false WHERE id=$1', [demo.service]);
  });
  for(const role of ['passenger','driver','ops']) sessions[role]=(await call('/api/v1/auth/demo','POST',{role})).data.token;
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});
let booking;
test('real catalog exposes ordered stops and server fares',async()=>{
  const routes=await call('/api/v1/routes');assert.equal(routes.data[0].stops.length,4);
  const services=await call(`/api/v1/services?originStopId=${demoId(200)}&destinationStopId=${demoId(203)}`);
  assert.equal(services.data[0].availability.fare.amountMinor,7500);
});
test('authenticated passenger creates and retrieves a hold',async()=>{
  const r=await call('/api/v1/bookings','POST',{serviceId:demo.service,origin:0,destination:1});assert.equal(r.status,200);booking=r.data;
  assert.equal((await call('/api/v1/me/bookings')).data[0].id,booking.id);
  assert.equal((await call(`/api/v1/bookings/${booking.id}`)).data.status,'held');
});
test('ops records payment and passenger confirms without client-supplied fare',async()=>{
  assert.equal((await call(`/api/v1/bookings/${booking.id}/confirm`,'POST')).status,409);
  assert.equal((await call(`/api/v1/bookings/${booking.id}/payments`,'POST',{provider:'cash',reference:'OPS-CASH-'+randomUUID().slice(0,8),amountMinor:2500,currency:'XOF'},'ops')).status,200);
  assert.equal((await call(`/api/v1/bookings/${booking.id}/confirm`,'POST')).data.status,'confirmed');
});
test('driver reads assignment and manifest then boards/alights',async()=>{
  assert.equal((await call('/api/v1/driver/service','GET',undefined,'driver')).data.id,demo.service);
  assert.equal((await call(`/api/v1/services/${demo.service}/manifest`,'GET',undefined,'driver')).data.length,1);
  assert.equal((await call(`/api/v1/bookings/${booking.id}/board`,'POST',{stopSequence:0},'driver')).data.status,'boarded');
  assert.equal((await call(`/api/v1/services/${demo.service}/advance`,'POST',{sequence:1},'driver')).status,200);
  assert.equal((await call(`/api/v1/bookings/${booking.id}/alight`,'POST',{stopSequence:1},'driver')).data.status,'completed');
});
test('position ingestion rejects stale observations',async()=>{
  const point={latitude:7.18,longitude:2.07,observedAt:new Date().toISOString()};
  assert.equal((await call(`/api/v1/services/${demo.service}/positions`,'POST',point,'driver')).status,200);
  assert.equal((await call(`/api/v1/services/${demo.service}/positions`,'POST',point,'driver')).status,409);
  assert.equal((await call(`/api/v1/services/${demo.service}/positions`,'GET',undefined,'driver')).data.latitude,7.18);
});
test('crew reports incident and ops assigns replacement with preserved capacity',async()=>{
  const incident=await call('/api/v1/incidents','POST',{serviceId:demo.service,kind:'breakdown',severity:'high',description:'Development test incident'},'driver');
  assert.equal(incident.status,200);
  assert.equal((await call(`/api/v1/incidents/${incident.data.id}`,'PATCH',{status:'investigating'},'ops')).status,200);
  const recovery=await call(`/api/v1/services/${demo.service}/recovery`,'POST',{incidentId:incident.data.id,vehicleId:demo.replacement,driverId:demo.driver},'ops');
  assert.equal(recovery.status,200);assert.equal(recovery.data.from_sequence,1);
  assert.equal((await call('/api/v1/ops/fleet','GET',undefined,'ops')).data.services[0].registration,'DEMO-RESERVE-01');
});
test('passengers cannot view fleet or create incidents',async()=>{
  assert.equal((await call('/api/v1/ops/fleet')).status,403);
  assert.equal((await call('/api/v1/incidents','POST',{serviceId:demo.service,kind:'other',severity:'low',description:'Invalid actor'})).status,403);
});
test('outbox records accompany successful business mutations',async()=>{
  const rows=await db.transaction(async tx=>(await tx.query('SELECT event_type FROM outbox')).rows);
  for(const type of ['booking.held','payment.recorded','booking.confirmed','booking.boarded','booking.completed','incident.created','service.recovery']) assert.ok(rows.some(r=>r.event_type===type));
});
