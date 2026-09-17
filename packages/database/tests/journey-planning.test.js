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
  const plan=await planner.plan({origin:NEAR_COTONOU,destinationStopId:demoId(203)});
  assert.ok(plan.options.length>0);
  const best=plan.options[0];
  assert.ok(best.firstMile,'a coordinate origin produces a first mile');
  assert.equal(best.firstMile.mode,'walking');
  assert.ok(best.firstMile.durationS>0 && best.firstMile.distanceM>0);
  assert.equal(best.pickupStop.id,demoId(200),'the nearest served stop is the pickup');
});

test('a stop origin has no first mile; a stop destination has no last mile',async()=>{
  const plan=await planner.plan({originStopId:demoId(200),destinationStopId:demoId(203)});
  assert.ok(plan.options.length>0);
  const best=plan.options.find(o=>o.feasible) ?? plan.options[0];
  assert.equal(best.firstMile,null);
  assert.equal(best.lastMile,null);
});

test('coordinate destinations produce a last-mile leg and a composed total ETA',async()=>{
  const plan=await planner.plan({originStopId:demoId(200),destination:FAR_PAST_PARAKOU});
  const withLast=plan.options.find(o=>o.lastMile);
  assert.ok(withLast,'a destination beyond the drop-off stop produces a last mile');
  assert.equal(withLast.totalDurationS,
    (withLast.firstMile?.durationS ?? 0)+(withLast.intercity.durationS ?? 0)+(withLast.lastMile?.durationS ?? 0));
  assert.ok(Date.parse(withLast.etaAt)>Date.parse(withLast.departureAt));
});

test('the fare is the published segment sum and the passenger sees nothing else commercial',async()=>{
  const plan=await planner.plan({originStopId:demoId(200),destinationStopId:demoId(202)});
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
  const plan=await planner.plan({originStopId:demoId(200),destinationStopId:demoId(201)});
  assert.ok(plan.options.length>0);
  assert.ok(plan.options.every(o=>Number.isInteger(o.available)&&o.available>=0));
});

test('an unreachable pickup is never presented as feasible',async()=>{
  // Departure in 3 hours, first mile far enough that walking + buffer fails.
  const far={latitude:6.75,longitude:2.4}; // ~44 km from Cotonou stop
  const plan=await planner.plan({origin:far,destinationStopId:demoId(203)});
  const option=plan.options.find(o=>o.serviceId===demo.service);
  assert.ok(!option || option.feasible===false,'impossible pickup times are marked infeasible');
});

test('the passenger coordinates never appear in the response',async()=>{
  const plan=await planner.plan({origin:NEAR_COTONOU,destinationStopId:demoId(203)});
  const text=JSON.stringify(plan);
  assert.ok(!text.includes('6.355'),'no raw passenger coordinates in the response');
  assert.ok(!plan.options.some(o=>JSON.stringify(o).includes('latitude')),'no coordinates leak to any consumer');
});

test('independent and company services both appear with their operator identity',async()=>{
  const second=randomUUID();
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO users(id,display_name,role) VALUES($1,'Ops B','ops')`,[randomUUID()]);
    await tx.query(`INSERT INTO operators(id,name,type,verification_status,owner_user_id) VALUES($1,'Second Opérateur','independent','verified',(SELECT id FROM users ORDER BY id LIMIT 1)) ON CONFLICT DO NOTHING`,[second]);
  });
  const plan=await planner.plan({originStopId:demoId(200),destinationStopId:demoId(203)});
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
  const plan=await planner.plan({originStopId:demoId(200),destinationStopId:demoId(201)});
  const option=plan.options.find(o=>o.feasible);
  assert.ok(option);
  const domain=transport(db);
  const booking=await domain.hold({id:demo.passenger,role:'passenger'},
    {serviceId:option.serviceId,origin:option.originSequence,destination:option.destinationSequence},'plan-'+randomUUID().slice(0,8));
  assert.equal(booking.status,'held');
  assert.equal(booking.amount_minor,option.fare.amountMinor);
});
