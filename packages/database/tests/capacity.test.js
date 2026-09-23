import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { transport } from '../src/transport.js';

const db=createDatabase({...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-','')});
const api=transport(db);
const passenger={id:demo.passenger,role:'passenger'};
const driver={id:demo.driver,role:'driver',operator_id:demo.operator};
const ops={id:demo.ops,role:'ops',operator_id:demo.operator};
const hold=(origin=0,destination=3,key=randomUUID())=>api.hold(passenger,{serviceId:demo.service,origin,destination},key);
async function confirmed(origin=0,destination=3) {
  const b=await hold(origin,destination);
  await api.recordPayment(ops,b.id,{provider:'demo',reference:randomUUID(),amountMinor:b.amount_minor,currency:'XOF'},randomUUID());
  return api.transition(passenger,b.id,'confirm');
}
before(async()=>{await migrate(db);await seed(db,{capacity:2});});
beforeEach(async()=>db.transaction(async tx=>{
  assert.ok(db.schema.startsWith('lr_test_'));
  await tx.query('TRUNCATE bookings, booking_segments, booking_passengers, payments, boarding_events, alighting_events, outbox CASCADE');
  await tx.query("UPDATE services SET current_sequence=0,status='active'");
}));
after(async()=>{
  try { await dropDisposableSchema(db); }
  finally {await db.close();}
});
test('full-route booking allocates every segment',async()=>{
  await hold();const a=await api.availability(demo.service,0,3);
  assert.deepEqual(a.segments.map(s=>s.occupied),[1,1,1]);assert.equal(a.available,1);
});
test('partial booking allocates only requested segments',async()=>{
  await hold(0,1);assert.deepEqual((await api.availability(demo.service,0,3)).segments.map(s=>s.occupied),[1,0,0]);
});
test('same seat is reusable on adjacent journeys',async()=>{
  const a=await hold(0,1),b=await hold(1,3);assert.equal(a.seat_number,b.seat_number);
});
test('a single full segment rejects a full-route booking',async()=>{
  await hold(1,2);await hold(1,2);await assert.rejects(hold(),{code:'SOLD_OUT'});
});
test('20 concurrent attempts cannot oversell two seats',async()=>{
  const attempts=await Promise.allSettled(Array.from({length:20},()=>hold()));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,2);
  assert.equal(attempts.filter(r=>r.status==='rejected' && r.reason.code==='SOLD_OUT').length,18);
  assert.deepEqual((await api.availability(demo.service,0,3)).segments.map(s=>s.occupied),[2,2,2]);
});
test('cancellation releases allocated capacity and is repeatable',async()=>{
  const b=await hold();await api.transition(passenger,b.id,'cancel');await api.transition(passenger,b.id,'cancel');
  assert.equal((await api.availability(demo.service,0,3)).available,2);
});
test('expiry releases capacity and expired holds cannot confirm',async()=>{
  const b=await hold();await db.transaction(tx=>tx.query("UPDATE bookings SET expires_at=now()-interval '1 minute' WHERE id=$1",[b.id]));
  await api.expireHolds();await assert.rejects(api.transition(passenger,b.id,'confirm'),{code:'INVALID_TRANSITION'});
  assert.equal((await api.availability(demo.service,0,3)).available,2);
});
test('invalid same-stop and reverse journeys are rejected',async()=>{
  await assert.rejects(hold(1,1),{code:'INVALID_JOURNEY'});await assert.rejects(hold(2,1),{code:'INVALID_JOURNEY'});
});
test('duplicate concurrent idempotency keys return one booking',async()=>{
  const key=randomUUID();const results=await Promise.all([hold(0,3,key),hold(0,3,key)]);
  assert.equal(results[0].id,results[1].id);await assert.rejects(hold(0,1,key),{code:'IDEMPOTENCY_CONFLICT'});
});
test('confirmation requires a verified matching payment',async()=>{
  const b=await hold();await assert.rejects(api.transition(passenger,b.id,'confirm'),{code:'PAYMENT_REQUIRED'});
  await assert.rejects(api.recordPayment(passenger,b.id,{provider:'cash',reference:'cash-receipt',amountMinor:b.amount_minor,currency:'XOF'},randomUUID()),{code:'FORBIDDEN'});
});
test('payment retries preserve one record and conflicting keys fail',async()=>{
  const b=await hold(),key=randomUUID();const input={provider:'demo',reference:randomUUID(),amountMinor:b.amount_minor,currency:'XOF'};
  const a=await api.recordPayment(ops,b.id,input,key),c=await api.recordPayment(ops,b.id,input,key);
  assert.equal(a.id,c.id);await assert.rejects(api.recordPayment(ops,b.id,{...input,amountMinor:1},key),{code:'IDEMPOTENCY_CONFLICT'});
});
test('boarding and alighting require assigned crew and correct stops',async()=>{
  const b=await confirmed(0,1);await assert.rejects(api.transition(passenger,b.id,'board',0),{code:'FORBIDDEN'});
  await assert.rejects(api.transition(driver,b.id,'board',1),{code:'WRONG_STOP'});
  await api.transition(driver,b.id,'board',0);await api.advance(driver,demo.service,1);
  await api.transition(driver,b.id,'alight',1);assert.equal((await api.booking(passenger,b.id)).status,'completed');
  assert.equal((await hold(1,3)).seat_number,b.seat_number);
});
test('unassigned drivers cannot read manifests and strangers cannot read tickets',async()=>{
  const b=await hold();await assert.rejects(api.manifest({...driver,id:randomUUID()},demo.service),{code:'FORBIDDEN'});
  await assert.rejects(api.booking({...passenger,id:randomUUID()},b.id),{code:'FORBIDDEN'});
});
test('database constraints reject out-of-capacity seats and incomplete occupation',async()=>{
  await assert.rejects(db.transaction(tx=>tx.query('INSERT INTO service_seats VALUES($1,3)',[demo.service])),{code:'23514'});
  const b=await hold();await assert.rejects(db.transaction(tx=>tx.query('DELETE FROM booking_segments WHERE booking_id=$1',[b.id])),{code:'23514'});
});
test('migration replay preserves checksums and data',async()=>{await migrate(db);assert.equal((await api.availability(demo.service,0,3)).capacity,2);});
test('boarding changes no occupancy, and alighting frees exactly the downstream segments',async()=>{
  const a=await confirmed(0,2);
  const before=(await api.availability(demo.service,0,3)).segments.map(s=>s.occupied);
  await api.transition(driver,a.id,'board',0);
  assert.deepEqual((await api.availability(demo.service,0,3)).segments.map(s=>s.occupied),before,
    'a boarded passenger still occupies their segments');
  const b=await hold(0,2);assert.ok(b,'the second seat on the overlapping span is sellable');
  await api.transition(passenger,b.id,'cancel');
  await api.advance(driver,demo.service,1);await api.advance(driver,demo.service,2);
  await api.transition(driver,a.id,'alight',2);
  assert.deepEqual((await api.availability(demo.service,0,3)).segments.map(s=>s.occupied),[0,0,0],
    'after alighting at C nothing holds the C→D segments');
});
test('a B→D booking respects an earlier A→C occupancy only where the spans overlap',async()=>{
  await hold(0,2);
  assert.deepEqual((await api.availability(demo.service,1,3)).segments.map(s=>s.occupied),[1,1,0],
    'segment B→C carries the A→C passenger, C→D does not');
  assert.equal((await api.availability(demo.service,2,3)).available,2,'C→D is untouched by A→C');
  const later=await hold(2,3);assert.ok(later,'the non-overlapping later segment is accepted');
});
test('an idempotent hold replay never writes a second set of segment rows',async()=>{
  const key=randomUUID();
  const a=await hold(0,3,key);
  const replay=await hold(0,3,key);
  assert.equal(replay.id,a.id,'the replay returns the same booking, not a second one');
  const rows=await db.transaction(tx=>tx.query('SELECT count(*)::int AS n FROM booking_segments WHERE booking_id=$1',[a.id]));
  assert.equal(rows.rows[0].n,3,'exactly one segment row per occupied segment');
  assert.deepEqual((await api.availability(demo.service,0,3)).segments.map(s=>s.occupied),[1,1,1],
    'the replay reserved one seat, not two');
});
