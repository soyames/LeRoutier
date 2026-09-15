import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journeyPlan, FIRST_MILE_POLICY } from '../src/index.js';

test('recommended leave time is derived from service timing, not invented',()=>{
  const plan=journeyPlan({departureAt:'2026-10-01T07:30:00.000Z'});
  assert.equal(plan.boardingOpensAt,'2026-10-01T07:10:00.000Z');
  assert.equal(plan.beThereBy,'2026-10-01T07:15:00.000Z');
  assert.equal(plan.boardingClosesAt,'2026-10-01T07:25:00.000Z');
  // Be there by 07:15, minus 25 minutes of local travel, minus a 10 minute buffer.
  assert.equal(plan.leaveBy,'2026-10-01T06:40:00.000Z');
  assert.equal(plan.travelMinutes,25);
  assert.equal(plan.travelSource,'policy_default');
  // LeRoutier has no live routing: every travel time is labelled an estimate.
  assert.equal(plan.estimated,true);
});

test('a client-supplied travel estimate sharpens the advice and stays labelled',()=>{
  const plan=journeyPlan({departureAt:'2026-10-01T07:30:00.000Z',localTravelMinutes:10});
  assert.equal(plan.leaveBy,'2026-10-01T06:55:00.000Z');
  assert.equal(plan.travelSource,'client_estimate');
  assert.equal(plan.estimated,true);
});

test('arrival is reported as scheduled or not, never guessed',()=>{
  const unscheduled=journeyPlan({departureAt:'2026-10-01T07:30:00.000Z'});
  assert.equal(unscheduled.arrivalAt,null);
  assert.equal(unscheduled.arrivalScheduled,false);
  const scheduled=journeyPlan({departureAt:'2026-10-01T07:30:00.000Z',arrivalAt:'2026-10-01T13:40:00.000Z'});
  assert.equal(scheduled.arrivalAt,'2026-10-01T13:40:00.000Z');
  assert.equal(scheduled.arrivalScheduled,true);
});

test('a delay moves the recommendation by exactly the delay',()=>{
  const before=journeyPlan({departureAt:'2026-10-01T07:30:00.000Z'});
  const after=journeyPlan({departureAt:'2026-10-01T08:00:00.000Z'});
  assert.equal(Date.parse(after.leaveBy)-Date.parse(before.leaveBy),30*60_000);
});

test('the timing policy is configurable rather than hardcoded per screen',()=>{
  assert.deepEqual(Object.keys(FIRST_MILE_POLICY).sort(),
    ['boardingClosesMinutes','boardingOpensMinutes','defaultLocalTravelMinutes','recommendedArrivalMinutes','safetyBufferMinutes']);
  const plan=journeyPlan({departureAt:'2026-10-01T07:30:00.000Z',
    policy:{...FIRST_MILE_POLICY,safetyBufferMinutes:30,defaultLocalTravelMinutes:15}});
  assert.equal(plan.leaveBy,'2026-10-01T06:30:00.000Z');
});

test('Date objects from the database keep their milliseconds',()=>{
  // The pg driver hands back Date objects. Date.parse() on a Date coerces via
  // String() and drops the milliseconds, which silently shifted every computed
  // time by up to a second; both input forms must agree exactly.
  const iso='2026-10-01T07:30:00.101Z';
  assert.equal(journeyPlan({departureAt:new Date(iso)}).departureAt,iso);
  assert.equal(journeyPlan({departureAt:new Date(iso)}).leaveBy,journeyPlan({departureAt:iso}).leaveBy);
  assert.equal(journeyPlan({departureAt:iso,arrivalAt:new Date('2026-10-01T13:40:00.250Z')}).arrivalAt,'2026-10-01T13:40:00.250Z');
});

test('invalid schedules and estimates are rejected',()=>{
  assert.throws(()=>journeyPlan({departureAt:'not-a-time'}),/Departure time is invalid/);
  assert.throws(()=>journeyPlan({departureAt:'2026-10-01T07:30:00.000Z',arrivalAt:'2026-10-01T06:00:00.000Z'}),/Arrival time is invalid/);
  assert.throws(()=>journeyPlan({departureAt:'2026-10-01T07:30:00.000Z',localTravelMinutes:-5}),/Local travel estimate is invalid/);
  assert.throws(()=>journeyPlan({departureAt:'2026-10-01T07:30:00.000Z',localTravelMinutes:2.5}),/Local travel estimate is invalid/);
});
