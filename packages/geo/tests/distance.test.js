import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceMetres, localTravelEstimateMinutes } from '../src/index.js';

const jonquet={latitude:6.3654,longitude:2.4183};

test('great-circle distance is computed for real coordinates',()=>{
  assert.equal(distanceMetres(jonquet,jonquet),0);
  const north={latitude:6.4000,longitude:2.4000};
  const metres=distanceMetres(jonquet,north);
  assert.ok(metres>3000 && metres<6000,`unexpected distance ${metres}`);
  // Symmetric, and Cotonou to Parakou is a few hundred kilometres.
  assert.equal(distanceMetres(north,jonquet),metres);
  assert.ok(distanceMetres(jonquet,{latitude:9.34,longitude:2.63})>300_000);
});

test('missing or invalid coordinates yield no distance rather than a wrong one',()=>{
  assert.equal(distanceMetres(null,jonquet),null);
  assert.equal(distanceMetres(jonquet,undefined),null);
  assert.equal(distanceMetres(jonquet,{latitude:NaN,longitude:2}),null);
  assert.equal(localTravelEstimateMinutes(null,jonquet),null);
});

test('local travel estimate is a coarse approximation, never a routed time',()=>{
  const minutes=localTravelEstimateMinutes({latitude:6.4000,longitude:2.4000},jonquet);
  assert.ok(Number.isInteger(minutes) && minutes>=10 && minutes<=30,`unexpected estimate ${minutes}`);
  // Farther away means longer, and the result stays within sane bounds.
  assert.ok(localTravelEstimateMinutes({latitude:6.50,longitude:2.40},jonquet)>minutes);
  assert.equal(localTravelEstimateMinutes({latitude:9.34,longitude:2.63},jonquet),600);
  assert.equal(localTravelEstimateMinutes(jonquet,jonquet),1);
});
