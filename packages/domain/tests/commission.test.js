import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCommission, priceWithServiceFee, LEROUTIER_COMMISSION_BP, LEROUTIER_SERVICE_FEE_BP } from '../src/index.js';

// Legacy parcel commission remains an integer split. Passenger tickets use the
// additive service-fee helper tested below.

test('the published example splits exactly: 7500 → 375 commission, 7125 net', () => {
  const split = splitCommission(7500);
  assert.equal(split.commissionMinor, 375);
  assert.equal(split.netMinor, 7125);
  assert.equal(LEROUTIER_COMMISSION_BP, 500);
});

test('gross = commission + net for every amount from 0 to 100000', () => {
  for (let gross = 0; gross <= 100_000; gross += 137) {
    const split = splitCommission(gross);
    assert.equal(split.grossMinor, gross);
    assert.equal(split.commissionMinor + split.netMinor, gross, `identity broken at ${gross}`);
    assert.ok(split.commissionMinor >= 0 && split.netMinor >= 0);
  }
});

test('rounding goes to the nearest FCFA, half rounds up', () => {
  assert.deepEqual(splitCommission(0), { grossMinor: 0, commissionMinor: 0, netMinor: 0, commissionBp: 500 });
  assert.equal(splitCommission(1).commissionMinor, 0);      // 0.05 → 0
  assert.equal(splitCommission(10).commissionMinor, 1);     // 0.5 → 1
  assert.equal(splitCommission(19).commissionMinor, 1);     // 0.95 → 1
  assert.equal(splitCommission(100).commissionMinor, 5);
  assert.equal(splitCommission(101).commissionMinor, 5);    // 5.05 → 5
  assert.equal(splitCommission(110).commissionMinor, 6);    // 5.5 → 6
});

test('other commission rates remain integer-safe', () => {
  assert.equal(splitCommission(7500, 1000).commissionMinor, 750); // 10 %
  assert.equal(splitCommission(7500, 0).commissionMinor, 0);
});

test('invalid inputs are rejected, never silently rounded', () => {
  assert.throws(() => splitCommission(-1));
  assert.throws(() => splitCommission(1.5));
  assert.throws(() => splitCommission('7500'));
  assert.throws(() => splitCommission(7500, -1));
  assert.throws(() => splitCommission(7500, 10001));
  assert.throws(() => splitCommission(7500, 1.5));
});

test('the operator fare is preserved and a 2% service fee is added on top',()=>{
  assert.deepEqual(priceWithServiceFee(2500),{fareMinor:2500,serviceFeeMinor:50,totalMinor:2550,feeBp:200});
  assert.equal(LEROUTIER_SERVICE_FEE_BP,200);
  assert.deepEqual(priceWithServiceFee(0),{fareMinor:0,serviceFeeMinor:0,totalMinor:0,feeBp:200});
  assert.throws(()=>priceWithServiceFee(-1));
  assert.throws(()=>priceWithServiceFee(1.1));
});
