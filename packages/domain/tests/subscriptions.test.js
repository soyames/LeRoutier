import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionFree, subscriptionPrice, subscriptionEnd, priceWithServiceFee, priorBeninMonth } from '../src/index.js';
test('free through the last millisecond of April 30 in Benin, payable at local midnight', () => {
  assert.equal(subscriptionFree('2027-04-30T23:59:59.999+01:00'), true);
  assert.equal(subscriptionFree('2027-05-01T00:00:00+01:00'), false);
  assert.equal(subscriptionFree('2027-04-30T23:00:00Z'), false);
});
test('both operator types have the exact prices for every billing period', () => {
  for (const [type, prices] of [['independent',[10000,60000,120000]],['company',[30000,180000,360000]]])
    ['monthly','halfYear','yearly'].forEach((period,i) => assert.equal(subscriptionPrice(type,period),prices[i]));
  assert.throws(() => subscriptionPrice('passenger','monthly'));
  assert.throws(() => subscriptionPrice('company','weekly'));
});
test('paid months use calendar boundaries and clamp month-end and leap dates', () => {
  assert.equal(subscriptionEnd('2027-01-31T08:00:00Z','monthly'),'2027-02-28T08:00:00.000Z');
  assert.equal(subscriptionEnd('2028-02-29T08:00:00Z','yearly'),'2029-02-28T08:00:00.000Z');
  assert.equal(subscriptionEnd('2027-04-30T23:30:00Z','monthly'),'2027-05-31T23:30:00.000Z');
});
test('2% is added to the published fare; actual provider fee remains separate', () => {
  assert.deepEqual(priceWithServiceFee(7500), { fareMinor:7500,serviceFeeMinor:150,totalMinor:7650,feeBp:200 });
  assert.equal(priceWithServiceFee(2500).totalMinor,2550);
  assert.throws(() => priceWithServiceFee(-1));
});
test('prior month uses Benin time, including UTC month and year rollover', () => {
  assert.deepEqual(priorBeninMonth('2027-04-30T23:00:00Z'), { start:'2027-03-31T23:00:00.000Z',end:'2027-04-30T23:00:00.000Z' });
  assert.deepEqual(priorBeninMonth('2027-01-01T00:00:00+01:00'), { start:'2026-11-30T23:00:00.000Z',end:'2026-12-31T23:00:00.000Z' });
});
