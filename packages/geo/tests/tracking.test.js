import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRESHNESS, freshness, estimateArrival, shouldPublishPosition } from '../src/tracking.js';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const ago = seconds => new Date(NOW - seconds * 1000).toISOString();

test('freshness distinguishes live, delayed, stale and unavailable',()=>{
  assert.equal(freshness(ago(10),NOW).state,'live');
  assert.equal(freshness(ago(FRESHNESS.liveSeconds+10),NOW).state,'delayed');
  assert.equal(freshness(ago(FRESHNESS.delayedSeconds+10),NOW).state,'stale');
  assert.equal(freshness(ago(FRESHNESS.staleSeconds+10),NOW).state,'unavailable');
  assert.equal(freshness(null,NOW).state,'unavailable');
  assert.equal(freshness(ago(45),NOW).ageSeconds,45);
  // A timestamp far in the future is not treated as fresh.
  assert.equal(freshness(new Date(NOW+3600_000).toISOString(),NOW).state,'unavailable');
});

test('no arrival estimate is produced without usable inputs',()=>{
  const none=estimateArrival({remainingM:null,observedAt:null,now:NOW});
  assert.equal(none.at,null);
  assert.equal(none.confidence,'unavailable');
});

test('without GPS the schedule is used and labelled as such',()=>{
  const scheduled=new Date(NOW+3600_000).toISOString();
  const eta=estimateArrival({remainingM:40_000,observedAt:null,scheduledAt:scheduled,now:NOW});
  assert.equal(eta.confidence,'scheduled');
  assert.equal(eta.source,'schedule');
  assert.equal(eta.at,scheduled);
});

test('recent GPS with real movement yields a live estimate',()=>{
  const observations=[
    {longitude:2.40,latitude:6.40,observedAt:ago(120)},
    {longitude:2.40,latitude:6.41,observedAt:ago(60)},
    {longitude:2.40,latitude:6.42,observedAt:ago(10)},
  ];
  const eta=estimateArrival({remainingM:20_000,observations,observedAt:ago(10),now:NOW});
  assert.equal(eta.confidence,'live');
  assert.equal(eta.source,'gps_movement');
  assert.ok(eta.speedMps>10,`speed ${eta.speedMps}`);
  assert.ok(Date.parse(eta.at)>NOW,'arrival is in the future');
  // Rounded to five minutes: the inputs do not support finer precision.
  assert.equal(Date.parse(eta.at)%300_000,0);
});

test('a stale signal downgrades a live estimate rather than keeping it',()=>{
  const observations=[
    {longitude:2.40,latitude:6.40,observedAt:ago(900)},
    {longitude:2.40,latitude:6.42,observedAt:ago(840)},
  ];
  const eta=estimateArrival({remainingM:20_000,observations,observedAt:ago(840),now:NOW});
  assert.notEqual(eta.confidence,'live');
  assert.equal(eta.confidence,'estimated');
  assert.equal(eta.signal,'stale');
});

test('a known position without usable movement is an estimate, not a live figure',()=>{
  const eta=estimateArrival({remainingM:30_000,observations:[],observedAt:ago(20),now:NOW});
  assert.equal(eta.confidence,'estimated');
  assert.equal(eta.source,'route_default_speed');
  assert.equal(eta.speedMps,null,'no speed is claimed when none was measured');
});

test('a longer remaining distance always arrives later',()=>{
  const common={observations:[],observedAt:ago(20),now:NOW};
  const near=estimateArrival({...common,remainingM:10_000});
  const far=estimateArrival({...common,remainingM:80_000});
  assert.ok(Date.parse(far.at)>Date.parse(near.at));
});

test('publishing a position requires movement or elapsed time, not every fix',()=>{
  const last={latitude:6.40,longitude:2.40,observedAt:ago(30)};
  const barelyMoved={latitude:6.4001,longitude:2.40,observedAt:ago(25),accuracyM:10};
  assert.equal(shouldPublishPosition(barelyMoved,last),false,'a parked bus does not drain the phone');
  const moved={latitude:6.4030,longitude:2.40,observedAt:ago(25),accuracyM:10};
  assert.equal(shouldPublishPosition(moved,last),true,'real movement is reported');
  // Stationary, but past the upper time interval: report so the signal is
  // known to be alive rather than silently going stale.
  const stationary={latitude:6.40,longitude:2.40,observedAt:ago(80)};
  const waited={latitude:6.4001,longitude:2.40,observedAt:new Date(NOW).toISOString(),accuracyM:10};
  assert.equal(shouldPublishPosition(waited,stationary),true,'the signal proves it is still alive');
  // The first fix of a trip always goes.
  assert.equal(shouldPublishPosition(moved,null),true);
});

test('a hopelessly imprecise or malformed fix is never published',()=>{
  const last={latitude:6.40,longitude:2.40,observedAt:ago(120)};
  assert.equal(shouldPublishPosition({latitude:6.5,longitude:2.4,observedAt:ago(10),accuracyM:5000},last),false);
  assert.equal(shouldPublishPosition({latitude:null,longitude:2.4,observedAt:ago(10)},last),false);
  assert.equal(shouldPublishPosition(null,last),false);
  // An observation older than the last one is not sent out of order.
  assert.equal(shouldPublishPosition({latitude:6.5,longitude:2.4,observedAt:ago(300)},last),false);
});
