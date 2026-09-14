import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePosition } from '../src/index.js';
test('valid observation is normalized',()=>assert.equal(validatePosition({latitude:6.36,longitude:2.43,observedAt:new Date().toISOString()}).latitude,6.36));
test('invalid coordinates and future observations are rejected',()=>{
  assert.throws(()=>validatePosition({latitude:91,longitude:2,observedAt:new Date().toISOString()}));
  assert.throws(()=>validatePosition({latitude:6,longitude:2,observedAt:new Date(Date.now()+300_000).toISOString()}));
});
