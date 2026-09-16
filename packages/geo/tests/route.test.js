import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidLine, cumulativeDistances, lineLengthMetres, nearestOnRoute, routeProgress,
  projectStops, nextStopFrom, stopStates, offRouteState, derivedSpeedMps } from '../src/route.js';

// A fixed corridor heading north along a meridian, so distances are easy to
// reason about: 0.01° of latitude is ~1.11 km. No live routing is involved.
const LINE = [[2.40, 6.36], [2.40, 6.46], [2.40, 6.56], [2.40, 6.66]];
const STOPS = [
  { sequence: 0, name: 'Cotonou', longitude: 2.40, latitude: 6.36 },
  { sequence: 1, name: 'Bohicon', longitude: 2.40, latitude: 6.46 },
  { sequence: 2, name: 'Dassa', longitude: 2.40, latitude: 6.56 },
  { sequence: 3, name: 'Parakou', longitude: 2.40, latitude: 6.66 },
];

test('a line is only valid as real lon/lat pairs',()=>{
  assert.equal(isValidLine(LINE),true);
  assert.equal(isValidLine([]),false);
  assert.equal(isValidLine([[2.4,6.4]]),false,'a single point is not a line');
  assert.equal(isValidLine([[2.4,6.4],[200,6.5]]),false,'longitude out of range');
  assert.equal(isValidLine([[2.4,6.4],[2.4,95]]),false,'latitude out of range');
  assert.equal(isValidLine([[2.4,6.4],[null,6.5]]),false);
  assert.equal(isValidLine('nope'),false);
});

test('cumulative distance increases monotonically and totals the line',()=>{
  const at=cumulativeDistances(LINE);
  assert.equal(at.length,LINE.length);
  assert.equal(at[0],0);
  for(let i=1;i<at.length;i++) assert.ok(at[i]>at[i-1],`vertex ${i} advances`);
  // Three hops of 0.10° latitude ≈ 33.4 km.
  assert.ok(Math.abs(lineLengthMetres(LINE)-33_350)<400,`unexpected length ${lineLengthMetres(LINE)}`);
});

test('a point beside the route projects onto it with its deviation measured',()=>{
  // ~110 m east of the line, halfway up the first segment.
  const nearest=nearestOnRoute(LINE,[2.401,6.41]);
  assert.equal(nearest.segment,0);
  assert.ok(nearest.offRouteM>80 && nearest.offRouteM<140,`off-route ${nearest.offRouteM}`);
  assert.ok(Math.abs(nearest.distanceAlongM-5_560)<300,`along ${nearest.distanceAlongM}`);
});

test('progress reports travelled, remaining and fraction along the road',()=>{
  const start=routeProgress(LINE,[2.40,6.36]);
  assert.equal(start.distanceAlongM,0);
  assert.equal(start.progress,0);
  assert.equal(start.remainingM,start.totalM);

  const middle=routeProgress(LINE,[2.40,6.51]);
  assert.ok(middle.progress>0.4 && middle.progress<0.6,`progress ${middle.progress}`);
  assert.equal(middle.distanceAlongM+middle.remainingM,middle.totalM);

  const end=routeProgress(LINE,[2.40,6.66]);
  assert.equal(end.remainingM,0);
  assert.equal(end.progress,1);
});

test('progress never rewinds on a noisy sample',()=>{
  const advanced=routeProgress(LINE,[2.40,6.51]);
  // A sample that projects behind the vehicle must not reduce progress.
  const noisy=routeProgress(LINE,[2.40,6.40],{previousAlongM:advanced.distanceAlongM});
  assert.equal(noisy.distanceAlongM,advanced.distanceAlongM);
  assert.ok(noisy.remainingM<=advanced.remainingM);
  // Genuine forward movement still advances.
  const forward=routeProgress(LINE,[2.40,6.60],{previousAlongM:advanced.distanceAlongM});
  assert.ok(forward.distanceAlongM>advanced.distanceAlongM);
});

test('invalid geometry or point yields no progress rather than a guess',()=>{
  assert.equal(routeProgress([[2.4,6.4]],[2.4,6.4]),null);
  assert.equal(routeProgress(LINE,null),null);
});

test('stops project onto the route in order',()=>{
  const projected=projectStops(LINE,STOPS);
  assert.deepEqual(projected.map(s=>s.sequence),[0,1,2,3]);
  for(let i=1;i<projected.length;i++) assert.ok(projected[i].distanceAlongM>=projected[i-1].distanceAlongM);
  assert.equal(projected[0].distanceAlongM,0);
  // A stop with no coordinates is carried through, not dropped or invented.
  const partial=projectStops(LINE,[{sequence:0,longitude:null,latitude:null}]);
  assert.equal(partial[0].distanceAlongM,null);
});

test('the next stop is ahead on the route, not merely the nearest one',()=>{
  const projected=projectStops(LINE,STOPS);
  // Just past Bohicon: the nearest stop is Bohicon, behind the vehicle.
  const along=routeProgress(LINE,[2.40,6.47]).distanceAlongM;
  const next=nextStopFrom(projected,along);
  assert.equal(next.name,'Dassa','the stop behind the vehicle is never "next"');
  // Operational truth wins: crew recorded arrival at Dassa.
  assert.equal(nextStopFrom(projected,along,{reachedSequence:2}).name,'Parakou');
  // Nothing ahead at the terminus.
  assert.equal(nextStopFrom(projected,lineLengthMetres(LINE),{reachedSequence:3}),null);
});

test('stop states describe the journey without overriding operational events',()=>{
  const projected=projectStops(LINE,STOPS);
  const along=routeProgress(LINE,[2.40,6.52]).distanceAlongM;
  const states=stopStates(projected,along);
  assert.equal(states[0].state,'passed');
  assert.equal(states[1].state,'passed');
  assert.equal(states[2].state,'next');
  assert.equal(states[3].state,'upcoming');
  // A crew-recorded arrival marks stops passed even if GPS lags behind.
  const withOperational=stopStates(projected,0,{reachedSequence:1});
  assert.equal(withOperational[0].state,'passed');
  assert.equal(withOperational[1].state,'passed');
  // Standing at a stop reads as arriving, not as already passed.
  assert.equal(stopStates(projected,projected[2].distanceAlongM)[2].state,'arriving');
});

test('one noisy sample never flags a vehicle off route',()=>{
  const tolerance={toleranceM:250,consecutive:3};
  assert.equal(offRouteState([{offRouteM:900}],tolerance).offRoute,false);
  assert.equal(offRouteState([{offRouteM:900},{offRouteM:10},{offRouteM:900}],tolerance).offRoute,false);
  // Sustained deviation does.
  const sustained=offRouteState([{offRouteM:900},{offRouteM:800},{offRouteM:1200}],tolerance);
  assert.equal(sustained.offRoute,true);
  assert.equal(sustained.worstOffRouteM,1200);
});

test('a deviation smaller than its own GPS accuracy proves nothing',()=>{
  const samples=[{offRouteM:300,accuracyM:1000},{offRouteM:320,accuracyM:1000},{offRouteM:310,accuracyM:1000}];
  assert.equal(offRouteState(samples).offRoute,false);
  assert.equal(offRouteState(samples).samples,0,'imprecise fixes are not counted');
});

test('speed is derived from movement and rejects impossible jumps',()=>{
  const base=Date.parse('2026-09-16T08:00:00Z');
  const at=(seconds,lat)=>({longitude:2.40,latitude:lat,observedAt:new Date(base+seconds*1000).toISOString()});
  // ~1.11 km in 60 s ≈ 18.5 m/s.
  const speed=derivedSpeedMps([at(0,6.36),at(60,6.37),at(120,6.38)]);
  assert.ok(speed>15 && speed<22,`speed ${speed}`);
  // A teleport between fixes is discarded rather than smoothed in.
  assert.equal(derivedSpeedMps([at(0,6.36),at(1,9.00)]),null);
  assert.equal(derivedSpeedMps([at(0,6.36)]),null,'one observation is not movement');
});
