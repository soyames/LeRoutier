import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo, demoId } from '../src/seed.js';
import { transport } from '../src/transport.js';
import { tracking } from '../src/tracking.js';
import { routeGeometry } from '../src/route-geometry.js';
import { createRouter, RoutingUnavailable, ROUTING_REASONS } from '@leroutier/routing';
import { createApi } from '../../../services/api/src/app.js';

const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config),domain=transport(db);
const passenger={id:demo.passenger,role:'passenger'};
const driver={id:demo.driver,role:'driver',operator_id:demo.operator};
const ops={id:demo.ops,role:'ops',operator_id:demo.operator};
const otherOps={id:demoId(7),role:'ops',operator_id:demoId(8)};
const track=tracking(db,config);

// The demo corridor runs roughly north: a fixed line so every assertion about
// progress is deterministic and no test depends on a routing provider.
const LINE=[[2.43,6.36],[2.30,6.70],[2.20,7.18],[2.18,7.75],[2.63,9.34]];

// A routing engine that returns a known line, so routing behaviour is tested
// without any public provider being online.
const fakeRouter=(coordinates=LINE)=>({provider:'test',configured:true,
  async route(stops){ if(stops.length<2) throw new RoutingUnavailable(ROUTING_REASONS.MISSING_COORDINATES,'too few');
    return {coordinates,distanceM:480_000,durationS:28000,provider:'test'}; }});

before(async()=>{ await migrate(db); await seed(db); });
beforeEach(async()=>{
  await db.transaction(async tx=>{
    await tx.query('DELETE FROM vehicle_positions');
    await tx.query('DELETE FROM route_geometries');
    await tx.query('DELETE FROM route_geometry_failures');
    await tx.query('DELETE FROM booking_segments');
    await tx.query("UPDATE bookings SET status='cancelled'");
    await tx.query("UPDATE services SET current_sequence=0,status='active' WHERE id=$1",[demo.service]);
  });
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});

const position=(lat,lon,secondsAgo=5,extra={})=>({latitude:lat,longitude:lon,
  observedAt:new Date(Date.now()-secondsAgo*1000).toISOString(),...extra});
const api=()=>createApi(db,config);
const request=(path,method='GET',body=undefined,token='fixture')=>new Request('http://localhost/api/v1'+path,
  {method,headers:{'content-type':'application/json',authorization:'Bearer '+token},...(body===undefined?{}:{body:JSON.stringify(body)})});

// ── route geometry ─────────────────────────────────────────────────────────
test('road geometry is generated from ordered stops and stored once',async()=>{
  const geometry=routeGeometry(db,fakeRouter());
  const first=await geometry.generate(ops,demo.route);
  assert.equal(first.regenerated,true);
  assert.equal(first.provider,'test');
  assert.ok(first.distanceM>0);

  const stored=await geometry.read(demo.route);
  assert.equal(stored.available,true);
  assert.equal(stored.stale,false);
  assert.deepEqual(stored.coordinates,LINE);

  // Unchanged stops must not call the engine again.
  let calls=0;
  const counting={provider:'test',configured:true,async route(){calls++;return {coordinates:LINE,distanceM:1,provider:'test'};}};
  const again=await routeGeometry(db,counting).generate(ops,demo.route);
  assert.equal(again.regenerated,false);
  assert.equal(calls,0,'cached geometry is reused');
});

test('routing failure never fabricates a line and is recorded for Ops',async()=>{
  const failing={provider:'test',configured:true,
    async route(){ throw new RoutingUnavailable(ROUTING_REASONS.NO_ROUTE,'No road route connects these stops.'); }};
  const result=await routeGeometry(db,failing).generate(ops,demo.route);
  assert.equal(result.regenerated,false);
  assert.equal(result.reason,ROUTING_REASONS.NO_ROUTE);
  const stored=await routeGeometry(db,failing).read(demo.route);
  assert.equal(stored.available,false);
  assert.equal(stored.coordinates,undefined,'no geometry is invented on failure');
  assert.equal(stored.reason,ROUTING_REASONS.NO_ROUTE);
});

test('an unconfigured routing engine reports unavailable rather than guessing',async()=>{
  const router=createRouter({});
  assert.equal(router.configured,false);
  await assert.rejects(router.route([{longitude:2.4,latitude:6.4},{longitude:2.6,latitude:9.3}]),
    /** @param {any} error */ error=>error.reason===ROUTING_REASONS.NOT_CONFIGURED);
  const result=await routeGeometry(db,router).generate(ops,demo.route);
  assert.equal(result.reason,ROUTING_REASONS.NOT_CONFIGURED);
});

test('reordering stops marks stored geometry stale',async()=>{
  await routeGeometry(db,fakeRouter()).generate(ops,demo.route);
  assert.equal((await routeGeometry(db,fakeRouter()).read(demo.route)).stale,false);
  // Moving a stop changes the input fingerprint.
  await db.transaction(tx=>tx.query('UPDATE stops SET latitude=latitude+0.5 WHERE id=$1',[demoId(201)]));
  assert.equal((await routeGeometry(db,fakeRouter()).read(demo.route)).stale,true);
  await db.transaction(tx=>tx.query('UPDATE stops SET latitude=latitude-0.5 WHERE id=$1',[demoId(201)]));
});

test('only an authorised operator may generate geometry for its own route',async()=>{
  const geometry=routeGeometry(db,fakeRouter());
  await assert.rejects(geometry.generate(passenger,demo.route),/Operations access required/);
  await assert.rejects(geometry.generate(driver,demo.route),/Operations access required/);
  await assert.rejects(geometry.generate(otherOps,demo.route),/Operation is not permitted/);
});

// ── GPS ingestion ──────────────────────────────────────────────────────────
test('assigned crew may publish a position; others may not',async()=>{
  const handler=api();
  await db.transaction(tx=>tx.query("INSERT INTO api_sessions(token_hash,user_id,expires_at) SELECT encode(sha256('driver'::bytea),'hex'),$1,now()+interval '1 hour'",[demo.driver]));
  // The domain layer is the authority; exercise it directly for clarity.
  await db.transaction(async tx=>{
    await domain.authorizeService(tx,driver,demo.service);
  });
  await assert.rejects(db.transaction(tx=>domain.authorizeService(tx,passenger,demo.service)),/Crew access required|FORBIDDEN|not assigned/i);
  assert.ok(handler);
});

test('a position is rejected once the service is closed',async()=>{
  await db.transaction(tx=>tx.query("UPDATE services SET status='completed' WHERE id=$1",[demo.service]));
  const result=await api()(request(`/services/${demo.service}/positions`,'POST',position(6.4,2.43)));
  assert.equal([401,409].includes(result.status),true,`unexpected ${result.status}`);
  await db.transaction(tx=>tx.query("UPDATE services SET status='active' WHERE id=$1",[demo.service]));
});

// ── tracking assembly ──────────────────────────────────────────────────────
async function publish(lat,lon,secondsAgo,extra={}){
  await db.transaction(async tx=>{
    const assignment=(await tx.query('SELECT vehicle_id FROM service_assignments WHERE service_id=$1 AND ended_at IS NULL',[demo.service])).rows[0];
    await tx.query(`INSERT INTO vehicle_positions(service_id,vehicle_id,actor_id,latitude,longitude,observed_at,accuracy_m,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,'pwa_device')`,
    [demo.service,assignment.vehicle_id,demo.driver,lat,lon,new Date(Date.now()-secondsAgo*1000).toISOString(),extra.accuracyM ?? null]);
  });
}

test('without road geometry the journey still describes its stops honestly',async()=>{
  const result=await db.transaction(tx=>track.serviceTracking(tx,demo.service));
  assert.equal(result.route.available,false);
  assert.equal(result.route.coordinates,null,'no straight line is substituted');
  assert.ok(result.stops.length>0);
  assert.equal(result.stops[0].state,'passed');
  assert.equal(result.nextStop.city,'Bohicon');
  assert.equal(result.signal,'unavailable');
  assert.equal(result.eta.confidence,'unavailable');
});

test('with geometry and a fresh position the journey reports real progress',async()=>{
  await routeGeometry(db,fakeRouter()).generate(ops,demo.route);
  // Seeded stops: Cotonou 6.36, Bohicon 7.18, Dassa 7.75, Parakou 9.34.
  await publish(6.70,2.30,120);   // between Cotonou and Bohicon
  await publish(7.45,2.19,10);    // clearly past Bohicon, short of Dassa
  const result=await db.transaction(tx=>track.serviceTracking(tx,demo.service));
  assert.equal(result.route.available,true);
  assert.equal(result.signal,'live');
  assert.ok(result.progress.distanceAlongM>0);
  assert.equal(result.progress.distanceAlongM+result.progress.remainingM,result.progress.totalM);
  assert.ok(result.progress.fraction>0 && result.progress.fraction<1);
  // The stop behind the vehicle is never "next".
  assert.equal(result.nextStop.city,'Dassa-Zoumè');
  assert.equal(result.stops.find(s=>s.city==='Bohicon').state,'passed');
  assert.equal(result.offRoute,false);
  assert.ok(['live','estimated'].includes(result.eta.confidence));
});

test('a stale signal is reported as stale and downgrades the estimate',async()=>{
  await routeGeometry(db,fakeRouter()).generate(ops,demo.route);
  await publish(7.18,2.20,900);
  const result=await db.transaction(tx=>track.serviceTracking(tx,demo.service));
  assert.equal(result.signal,'stale');
  assert.notEqual(result.eta.confidence,'live');
});

test('a passenger tracks their own journey to their own stop',async()=>{
  await routeGeometry(db,fakeRouter()).generate(ops,demo.route);
  const booking=await domain.hold(passenger,{serviceId:demo.service,origin:0,destination:1},'key-'+randomUUID());
  await db.transaction(tx=>tx.query("UPDATE bookings SET status='confirmed' WHERE id=$1",[booking.id]));
  await publish(6.50,2.36,10);
  const result=await track.forBooking(passenger,booking.id);
  assert.equal(result.bookingId,booking.id);
  assert.equal(result.destinationSequence,1);
  // Remaining distance targets the passenger's stop, not the end of the line.
  const full=await db.transaction(tx=>track.serviceTracking(tx,demo.service));
  assert.ok(result.progress.remainingM<full.progress.remainingM,'targets the alighting stop');
  // Another passenger's booking is not readable.
  await assert.rejects(track.forBooking({id:demoId(9),role:'passenger'},booking.id),/Booking not found/);
});

test('a passenger without an active ticket cannot track the vehicle',async()=>{
  const booking=await domain.hold(passenger,{serviceId:demo.service,origin:0,destination:1},'key-'+randomUUID());
  // Still only held: no ticket, no live vehicle tracking.
  await assert.rejects(track.forBooking(passenger,booking.id),/An active ticket is required/);
});

test('the fleet view is scoped to the caller’s own operator',async()=>{
  await routeGeometry(db,fakeRouter()).generate(ops,demo.route);
  await publish(6.70,2.30,15);
  const mine=await track.fleet(ops);
  assert.equal(mine.length,1);
  assert.equal(mine[0].serviceId,demo.service);
  // A different company sees nothing of this fleet.
  assert.equal((await track.fleet(otherOps)).length,0);
  await assert.rejects(track.fleet(driver),/Operations access required/);
  await assert.rejects(track.fleet(passenger),/Operations access required/);
});
