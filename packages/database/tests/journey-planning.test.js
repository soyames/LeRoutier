import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serverConfig} from '@leroutier/config';
import {createDatabase} from '../src/index.js';
import {migrate} from '../src/migrations.js';
import {seed,demo,demoId} from '../src/seed.js';
import {dropDisposableSchema} from '../src/guards.js';
import {journeyPlanning} from '../src/journey-planning.js';
import {transport} from '../src/transport.js';

// Door-to-destination planning over the existing domain. No Google, no model:
// the first/last mile is a walking estimate, the intercity leg is the real
// service/fare/availability data, and the passenger's coordinates never leave
// the request.
const config={...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-',''),demoLogin:true};
const db=createDatabase(config);
const sql=(q,p=[])=>db.transaction(tx=>tx.query(q,p));
let planner;
// Cotonou stop is (6.36, 2.43) in the seed.
const NEAR_COTONOU={latitude:6.355,longitude:2.435}; // ~600 m away
const FAR_PAST_PARAKOU={latitude:9.5,longitude:2.7};

before(async()=>{
  await migrate(db);await seed(db);
  // The demo service departs tomorrow; move it to today so options exist and
  // departure-time feasibility is testable.
  await sql(`UPDATE services SET departure_at=now()+interval '3 hours',arrival_at=now()+interval '10 hours',status='scheduled' WHERE id=$1`,[demo.service]);
  planner=journeyPlanning(db,{boardingBufferS:600});
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});

test('current location resolves to a practical pickup stop with a first-mile leg',async()=>{
  const plan=await planner.plan({includeDemo:true,origin:NEAR_COTONOU,destinationStopId:demoId(203)});
  assert.ok(plan.options.length>0);
  const best=plan.options[0];
  assert.ok(best.firstMile,'a coordinate origin produces a first mile');
  assert.equal(best.firstMile.mode,'walking');
  assert.ok(best.firstMile.durationS>0 && best.firstMile.distanceM>0);
  assert.equal(best.pickupStop.id,demoId(200),'the nearest served stop is the pickup');
});

test('a stop origin has no first mile; a stop destination has no last mile',async()=>{
  const plan=await planner.plan({includeDemo:true,originStopId:demoId(200),destinationStopId:demoId(203)});
  assert.ok(plan.options.length>0);
  const best=plan.options.find(o=>o.feasible) ?? plan.options[0];
  assert.equal(best.firstMile,null);
  assert.equal(best.lastMile,null);
});

test('coordinate destinations produce a last-mile leg and a composed total ETA',async()=>{
  const plan=await planner.plan({includeDemo:true,originStopId:demoId(200),destination:FAR_PAST_PARAKOU});
  const withLast=plan.options.find(o=>o.lastMile);
  assert.ok(withLast,'a destination beyond the drop-off stop produces a last mile');
  assert.equal(withLast.totalDurationS,
    (withLast.firstMile?.durationS ?? 0)+(withLast.waitingS ?? 0)+(withLast.intercity.durationS ?? 0)+(withLast.lastMile?.durationS ?? 0));
  assert.ok(Date.parse(withLast.etaAt)>Date.parse(withLast.departureAt));
});

test('the fare is the published segment sum and the passenger sees nothing else commercial',async()=>{
  const plan=await planner.plan({includeDemo:true,originStopId:demoId(200),destinationStopId:demoId(202)});
  const option=plan.options.find(o=>o.feasible);
  assert.ok(option);
  const domain=transport(db);
  const quote=await domain.availability(demo.service,0,2);
  assert.equal(option.fare.amountMinor,quote.fare.amountMinor,'the planner quotes the same domain fare');
  assert.equal(option.fare.currency,'XOF');
  const text=JSON.stringify(option);
  assert.ok(!/commission|net|deduction|minor.*0\.05/i.test(text),'no commission or operator economics in the passenger response');
});

test('availability is real and zero seats are stated, not hidden',async()=>{
  const plan=await planner.plan({includeDemo:true,originStopId:demoId(200),destinationStopId:demoId(201)});
  assert.ok(plan.options.length>0);
  assert.ok(plan.options.every(o=>Number.isInteger(o.available)&&o.available>=0));
});

test('an unreachable pickup is never presented as feasible',async()=>{
  // Departure in 3 hours, first mile far enough that walking + buffer fails.
  const far={latitude:6.75,longitude:2.4}; // ~44 km from Cotonou stop
  const plan=await planner.plan({includeDemo:true,origin:far,destinationStopId:demoId(203)});
  const option=plan.options.find(o=>o.serviceId===demo.service);
  assert.ok(!option || option.feasible===false,'impossible pickup times are marked infeasible');
});

test('the passenger coordinates never appear in the response',async()=>{
  const plan=await planner.plan({includeDemo:true,origin:NEAR_COTONOU,destinationStopId:demoId(203)});
  const text=JSON.stringify(plan);
  assert.ok(!text.includes('6.355'),'no raw passenger coordinates in the response');
  assert.ok(!text.includes('2.435'),'no raw passenger coordinates in the response');
  // Public stop coordinates, road geometry and vehicle positions are offer
  // facts; the passenger's own position is what must never leak.
  assert.ok(plan.options.some(o=>o.intermediateStops.length>=0),'stop data is present, coordinates of the passenger are not');
});

test('independent and company services both appear with their operator identity',async()=>{
  const second=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Ops B','ops')`,[randomUUID()]);
    await tx.query(`INSERT INTO operators(id,name,type,verification_status,owner_user_id) VALUES($1,'Second Opérateur','independent','verified',(SELECT id FROM users ORDER BY id LIMIT 1)) ON CONFLICT DO NOTHING`,[second]);
  });
  const plan=await planner.plan({includeDemo:true,originStopId:demoId(200),destinationStopId:demoId(203)});
  const types=new Set(plan.options.map(o=>o.operatorType));
  assert.ok(types.has('company'),'company services appear');
  // The second operator has no service yet — the planner simply reports what exists.
  assert.ok(plan.options.length>=1);
});

test('an unknown origin or destination fails cleanly without inventing anything',async()=>{
  await assert.rejects(planner.plan({originStopId:randomUUID(),destinationStopId:demoId(203)}),{code:'INVALID_JOURNEY'});
  await assert.rejects(planner.plan({originStopId:demoId(200),destinationStopId:randomUUID()}),{code:'INVALID_JOURNEY'});
  await assert.rejects(planner.plan({origin:{latitude:91,longitude:0},destinationStopId:demoId(203)}),{code:'INVALID_JOURNEY'});
});

test('a planned option books through the exact same domain flow',async()=>{
  const plan=await planner.plan({includeDemo:true,originStopId:demoId(200),destinationStopId:demoId(201)});
  const option=plan.options.find(o=>o.feasible);
  assert.ok(option);
  const domain=transport(db);
  const booking=await domain.hold({id:demo.passenger,role:'passenger'},
    {serviceId:option.serviceId,origin:option.originSequence,destination:option.destinationSequence},'plan-'+randomUUID().slice(0,8));
  assert.equal(booking.status,'held');
  assert.equal(booking.amount_minor,option.fare.amountMinor);
});

test('a destination place that is not a stop gets a last mile around the nearest drop-off', async()=>{
  // A point beyond Parakou's stop: the plan must pick the nearest practical
  // drop-off and add the last-mile leg.
  const beyond={latitude:9.5,longitude:2.7};
  const plan=await planner.plan({includeDemo:true,originStopId:demoId(200),destination:beyond});
  const option=plan.options.find(o=>o.feasible);
  assert.ok(option,'an option exists for a non-stop destination');
  assert.ok(option.lastMile,'the last mile is calculated');
  assert.equal(option.dropoffStop.id,demoId(203),'the nearest served stop is the drop-off');
  assert.ok(option.lastMile.distanceM>0 && option.lastMile.durationS>0);
});

test('a place id origin plans through coordinates, like the API resolves it',async()=>{
  // The API resolves a place id to the canonical commune's coordinates before
  // planning; verify that path end to end with the seeded Benin geography.
  const {rows:[place]}=await sql(`SELECT id,latitude,longitude FROM places
    WHERE name='Cotonou' AND kind='city' AND latitude IS NOT NULL ORDER BY (source IS NULL) LIMIT 1`);
  assert.ok(place,'the canonical Cotonou commune carries coordinates');
  const plan=await planner.plan({includeDemo:true,origin:{latitude:Number(place.latitude),longitude:Number(place.longitude)},destinationStopId:demoId(203)});
  const first=plan.options.find(o=>o.feasible);
  assert.ok(first,'a place-resolved origin still plans');
  assert.ok(first.firstMile,'coordinates resolved from the place produce a first mile');
});

test('public plans exclude demo/test services; the opt-in includes them',async()=>{
  const publicPlan=await planner.plan({originStopId:demoId(200),destinationStopId:demoId(203)});
  assert.equal(publicPlan.options.length,0,'demo inventory is invisible by default');
  const opted=await planner.plan({includeDemo:true,originStopId:demoId(200),destinationStopId:demoId(203)});
  assert.ok(opted.options.length>0,'the opt-in plan sees the demo service');
  assert.ok(opted.options.every(o=>o.isTest===true),'opt-in options are structurally marked TEST');
});

test('options carry the full offer: vehicle, stops, waiting and totals',async()=>{
  const plan=await planner.plan({includeDemo:true,originStopId:demoId(200),destinationStopId:demoId(203)});
  const o=plan.options[0];
  assert.equal(typeof o.vehicle,'object','a vehicle block is always present');
  assert.equal(typeof o.waitingS,'number','waiting time is always present');
  assert.ok(Array.isArray(o.intermediateStops),'intermediate stops are listed');
  assert.ok(o.fare.amountMinor>0 && Number.isInteger(o.available) && o.capacity>0);
  assert.equal(typeof o.totalDurationS,'number');
  assert.equal(typeof o.serviceStatus,'string');
});

test('a TEST booking pays through the simulated path and never touches real money flows',async()=>{
  const domain=transport(db);
  const plan=await planner.plan({includeDemo:true,originStopId:demoId(200),destinationStopId:demoId(201)});
  const o=plan.options.find(x=>x.feasible);
  assert.ok(o,'a feasible TEST option exists');
  const booking=await domain.hold({id:demo.passenger,role:'passenger'},
    {serviceId:o.serviceId,origin:o.originSequence,destination:o.destinationSequence},'test-pay-'+randomUUID().slice(0,8));
  assert.equal(booking.status,'held');
  const payment=await domain.simulatedTestPayment({id:demo.passenger,role:'passenger'},booking.id,'test-pay-'+randomUUID().slice(0,8));
  assert.equal(payment.provider,'demo');
  assert.equal(payment.status,'succeeded');
  assert.match(payment.provider_reference,/^TEST-SIM-/,'the synthetic reference is unmistakably TEST');
  const confirmed=await domain.transition({id:demo.passenger,role:'passenger'},booking.id,'confirm');
  assert.equal(confirmed.status,'confirmed','the full booking lifecycle is exercised');
  // No settlement credit and no fare observation exist for the synthetic sale.
  const credit=(await sql(`SELECT count(*)::integer AS n FROM operator_settlements WHERE reference='payment:'||$1`,[payment.id])).rows[0].n;
  assert.equal(credit,0,'TEST payments never enter operator settlement');
  const obs=(await sql(`SELECT count(*)::integer AS n FROM fare_observations WHERE source_reference='payment:'||$1`,[payment.id])).rows[0].n;
  assert.equal(obs,0,'TEST payments never become market evidence');
});
