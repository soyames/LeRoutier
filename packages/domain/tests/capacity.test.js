import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journeySegments, occupiedBySegment, availableCapacity, validateTransition } from '../src/index.js';

test('full route affects all three segments',()=>assert.deepEqual(journeySegments(0,3,4),[0,1,2]));
test('partial journey affects only its interval',()=>assert.deepEqual(journeySegments(1,3,4),[1,2]));
test('adjacent passengers reuse capacity',()=>assert.deepEqual(occupiedBySegment(4,[
  {origin:0,destination:1,status:'confirmed'}, {origin:1,destination:3,status:'boarded'},
]),[1,1,1]));
test('one full segment blocks the journey',()=>assert.equal(availableCapacity(2,[0,2,0],0,3),0));
test('cancelled, completed and expired holds do not occupy capacity',()=>assert.deepEqual(occupiedBySegment(4,[
  ...['cancelled','completed','expired'].map(status=>({origin:0,destination:3,status})),
  {origin:0,destination:3,status:'held',expiresAt:'2000-01-01'},
]),[0,0,0]));
test('reverse, same-stop, fractional and out-of-range journeys fail',()=>{
  for(const [i,j] of [[2,1],[1,1],[-1,2],[0,4],[0.5,2]]) assert.throws(()=>journeySegments(i,j,4));
});
test('status transitions enforce booking lifecycle',()=>{
  assert.equal(validateTransition('held','confirm'),'confirmed');
  assert.equal(validateTransition('confirmed','board'),'boarded');
  assert.equal(validateTransition('boarded','alight'),'completed');
  assert.throws(()=>validateTransition('expired','confirm'));
  assert.throws(()=>validateTransition('held','board'));
});
