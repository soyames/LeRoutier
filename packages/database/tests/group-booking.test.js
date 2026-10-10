// Buying several tickets in one purchase.
//
// The product rule this suite exists to defend: a family pays ONCE, every
// traveller gets a real seat and their own usable ticket, and the party is
// confirmed together or not at all. The failure modes worth testing are the
// ones a per-seat implementation gets wrong — a seat that is reserved on one
// leg and free on the next, a payment that covers the party being compared
// against one seat's fare, and a half-confirmed party after an error.
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { transport, bookingMoney, MAX_GROUP_QUANTITY } from '../src/transport.js';
import { payments } from '../src/payments.js';
import { tickets } from '../src/tickets.js';
import { guestCheckout } from '../src/guest-checkout.js';

const CAPACITY = 4;
const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
const domain = transport(db);
const guest = guestCheckout(db);
// A provider that never leaves the process: this suite is about the domain's
// money rules, and the FedaPay wire format has its own suite.
const adapter = { name: 'fedapay', initiate: async () => ({ reference: 'FAKE-' + randomUUID(), checkoutUrl: null, metadata: {} }), reconcilePayment: async () => null };
const pay = payments(db, adapter);
const ticket = tickets(db);
const passenger = { id: demo.passenger, role: 'passenger' };

const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));
const all = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows));
const hold = (quantity, extra = {}) => domain.holdGroup(passenger, { serviceId: demo.service, origin: 0, destination: 3, quantity, ...extra }, randomUUID());
// A provider event must quote the reference the provider actually returned.
const referenceOf = async id => (await one('SELECT provider_reference FROM payments WHERE id=$1', [id])).provider_reference;

before(async () => {
  await migrate(db);
  await seed(db, { capacity: CAPACITY });
  // The seeded service is marked TEST, and TEST purchases deliberately never
  // touch settlement or market evidence. The money assertions here are about
  // real settlement, so this suite runs the same service as a real one.
  await db.transaction(tx => tx.query('UPDATE services SET is_demo=false WHERE id=$1', [demo.service]));
});
beforeEach(async () => {
  await db.transaction(async tx => {
    assert.ok(db.schema.startsWith('lr_test_'));
    await tx.query(`TRUNCATE bookings, booking_segments, booking_passengers, payments, boarding_events,
      alighting_events, outbox, booking_groups, payment_events, operator_settlements, fare_observations CASCADE`);
    // Guest identities are NOT cleaned up between tests, because they cannot be:
    // the audit trail records their creation and is append-only by trigger, which
    // is the schema saying that a buyer — even one with no account — is a durable
    // fact rather than scratch data. The suites below therefore assert what they
    // created rather than a global count.
    await tx.query('DELETE FROM api_sessions');
    await tx.query("UPDATE services SET current_sequence=0,status='active',is_demo=false");
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

const groupSeats = id => all('SELECT seat_number,origin_sequence,destination_sequence,status FROM bookings WHERE group_id=$1 ORDER BY seat_number', [id]);
const segmentCount = id => one(`SELECT count(*)::integer AS n FROM booking_segments bs
  JOIN bookings b ON b.id=bs.booking_id WHERE b.group_id=$1`, [id]);

// ── the seats ───────────────────────────────────────────────────────────────

test('one purchase reserves a distinct seat on every segment for every traveller', async () => {
  const group = await hold(3);
  assert.equal(group.quantity, 3);
  assert.equal(group.amount_minor, group.perPassengerMinor * 3, 'the total is the number of seats times the fare');
  const seats = await groupSeats(group.id);
  assert.equal(seats.length, 3, 'one booking per traveller');
  assert.deepEqual(seats.map(s => s.seat_number), [...new Set(seats.map(s => s.seat_number))].sort((a, b) => a - b),
    'and no two travellers share a seat');
  // Three stops crossed (0→1, 1→2, 2→3) means three segment rows per seat.
  assert.equal(await segmentCount(group.id).then(r => r.n), 9);
  assert.equal((await one('SELECT available FROM (SELECT count(*)::integer AS available FROM service_seats seats WHERE service_id=$1 AND NOT EXISTS (SELECT 1 FROM booking_segments bs WHERE bs.service_id=seats.service_id AND bs.seat_number=seats.seat_number AND bs.sequence>=0 AND bs.sequence<3)) t', [demo.service])).available,
    1, 'a coach of four with three seats sold has one left');
});

test('quantity 1 is the same purchase as it has always been, only wrapped', async () => {
  const group = await hold(1);
  assert.equal(group.quantity, 1);
  assert.equal(group.bookings.length, 1);
  assert.equal(group.amount_minor, group.bookings[0].amount_minor, 'the party total is the single fare');
  assert.equal(await segmentCount(group.id).then(r => r.n), 3);
});

test('every quantity from one to the maximum holds exactly that many seats', async () => {
  for (const quantity of [1, 2, 3, CAPACITY]) {
    await db.transaction(tx => tx.query(`TRUNCATE bookings, booking_segments, booking_passengers, payments, booking_groups CASCADE`));
    const group = await hold(quantity);
    assert.equal((await groupSeats(group.id)).length, quantity, `quantity ${quantity} holds ${quantity} seats`);
  }
  assert.equal(MAX_GROUP_QUANTITY, 10, 'the product ceiling is ten tickets in one purchase');
});

test('a quantity the coach cannot seat is refused whole, and holds nothing', async () => {
  await hold(CAPACITY - 1);
  // One seat left, two asked for: refused, and the one free seat is untouched.
  await assert.rejects(hold(2), { code: 'SOLD_OUT' });
  assert.equal((await one('SELECT count(*)::integer AS n FROM booking_groups')).n, 1, 'no purchase row was written');
  assert.equal((await one('SELECT count(*)::integer AS n FROM bookings')).n, CAPACITY - 1);
});

test('quantities outside 1..10 are refused before anything is reserved', async () => {
  for (const quantity of [0, -1, MAX_GROUP_QUANTITY + 1, 2.5, '3', null]) {
    if (quantity === null) continue; // null means "not given", which is quantity 1
    await assert.rejects(hold(quantity), { code: 'INVALID_QUANTITY' }, `quantity ${quantity}`);
  }
  assert.equal((await one('SELECT count(*)::integer AS n FROM bookings')).n, 0);
});

test('concurrent purchases cannot oversell a coach between them', async () => {
  // Six purchases of two seats against a coach of four: exactly two may win.
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => hold(2)));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(attempts.filter(r => r.status === 'rejected' && r.reason.code === 'SOLD_OUT').length, 4);
  assert.equal((await one('SELECT count(*)::integer AS n FROM bookings')).n, 4);
  assert.equal((await one('SELECT count(*)::integer AS n FROM booking_segments')).n, 12);
});

test('a retried purchase returns the same party and writes nothing extra', async () => {
  const key = randomUUID();
  const input = { serviceId: demo.service, origin: 0, destination: 3, quantity: 2 };
  const first = await domain.holdGroup(passenger, input, key);
  const replay = await domain.holdGroup(passenger, input, key);
  assert.equal(replay.id, first.id);
  assert.equal((await one('SELECT count(*)::integer AS n FROM booking_groups')).n, 1);
  assert.equal((await one('SELECT count(*)::integer AS n FROM bookings')).n, 2, 'the seats were not reserved twice');
  await assert.rejects(domain.holdGroup(passenger, { ...input, quantity: 3 }, key), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('a fare the customer was shown that no longer holds is refused, not applied', async () => {
  const quote = await domain.availability(demo.service, 0, 3);
  await assert.rejects(hold(2, { expectedAmountMinor: quote.fare.amountMinor }), { code: 'FARE_CHANGED' });
  assert.equal((await one('SELECT count(*)::integer AS n FROM booking_groups')).n, 0);
  const agreed = await hold(2, { expectedAmountMinor: quote.fare.amountMinor * 2 });
  assert.equal(agreed.amount_minor, quote.fare.amountMinor * 2);
});

test('chosen seats are honoured, and a clash is refused rather than silently reshuffled', async () => {
  const chosen = await hold(2, { seatNumbers: [3, 1] });
  assert.deepEqual((await groupSeats(chosen.id)).map(s => s.seat_number), [1, 3]);
  await assert.rejects(hold(1, { seatNumber: 1 }), { code: 'SEAT_TAKEN' });
  await assert.rejects(hold(2, { seatNumbers: [2, 2] }), { code: 'INVALID_SEAT' });
});

// ── the money ───────────────────────────────────────────────────────────────

test('the whole party confirms together on one payment for the party total', async () => {
  const group = await hold(2);
  const payment = await pay.initiate(passenger, group.id, {}, randomUUID());
  assert.equal(payment.amountMinor, group.amount_minor+group.service_fee_minor, 'one charge for the party including the service fee');
  assert.equal(payment.groupId, group.id);
  assert.equal(payment.bookingId, null, 'a party payment settles the purchase, not a seat');

  await pay.applyEvent({ kind: 'payment', paymentId: payment.id, eventId: 'evt-1', reference: await referenceOf(payment.id),
    amountMinor: group.amount_minor+group.service_fee_minor, currency: 'XOF', status: 'succeeded' });
  const seats = await groupSeats(group.id);
  assert.ok(seats.every(s => s.status === 'confirmed'), JSON.stringify(seats));
  const stored = await one('SELECT status FROM booking_groups WHERE id=$1', [group.id]);
  assert.equal(stored.status, 'held', 'the purchase row tracks payment, the seats track travel');
});

test('a seat inside a party cannot be charged for on its own', async () => {
  const group = await hold(2);
  const seat = group.bookings[0];
  await assert.rejects(pay.initiate(passenger, seat.id, {}, randomUUID()), { code: 'PAYMENT_TARGET_GROUPED' });
  await assert.rejects(domain.simulatedTestPayment(passenger, seat.id, randomUUID(), { allowTestInventory: true }),
    { code: 'PAYMENT_TARGET_GROUPED' });
  assert.equal((await one('SELECT count(*)::integer AS n FROM payments')).n, 0);
});

test('the party settles as a whole: the payment covers every seat, not one fare', async () => {
  const group = await hold(3);
  const member = await one('SELECT * FROM bookings WHERE group_id=$1 ORDER BY seat_number LIMIT 1', [group.id]);
  const payment = await pay.initiate(passenger, group.id, {}, randomUUID());
  await pay.applyEvent({ kind: 'payment', paymentId: payment.id, eventId: 'evt-1', reference: await referenceOf(payment.id),
    amountMinor: group.amount_minor+group.service_fee_minor, currency: 'XOF', status: 'succeeded' });

  // This is the assertion the whole grouped design turns on. One seat's own fare
  // is three times smaller than the payment that settled it, so a rule that
  // compared the two would leave every member of a paid party permanently
  // unconfirmable and every ticket unboardable at the door.
  const money = await db.transaction(tx => bookingMoney(tx, member));
  assert.notEqual(member.amount_minor, group.amount_minor, 'the seat fare really is smaller than the party total');
  assert.equal(money.dueMinor, group.amount_minor+group.service_fee_minor, 'the seat is covered by the purchase total');
  assert.equal(money.settled, true);

  const issued = await ticket.issue(passenger, member.id);
  assert.equal(issued.validForBoarding, true, 'a member of a paid party holds a boardable ticket');
  assert.ok(issued.token && issued.token.startsWith('LRT1.'));
});

test('one payment per purchase: a second pending charge is refused', async () => {
  const group = await hold(2);
  await pay.initiate(passenger, group.id, {}, randomUUID());
  await assert.rejects(pay.initiate(passenger, group.id, {}, randomUUID()), { code: 'PAYMENT_EXISTS' });
});

test('the settlement is credited once for the party total, and a replayed event adds nothing', async () => {
  const group = await hold(2);
  const payment = await pay.initiate(passenger, group.id, {}, randomUUID());
  const event = { kind: 'payment', paymentId: payment.id, eventId: 'evt-1', reference: await referenceOf(payment.id),
    amountMinor: group.amount_minor+group.service_fee_minor, currency: 'XOF', status: 'succeeded' };
  await pay.applyEvent(event);
  const credited = await all('SELECT gross_minor,deduction_minor FROM operator_settlements');
  assert.equal(credited.length, 1, 'one credit for the party');
  assert.equal(credited[0].gross_minor, group.amount_minor);
  assert.equal(credited[0].deduction_minor,0,'the service fee is added on top of the operator fare');
  assert.equal(credited[0].gross_minor,group.amount_minor);

  // The same event again, and the same collection under a different event id —
  // FedaPay reports one collection as both approved and transferred.
  await pay.applyEvent(event);
  await pay.applyEvent({ ...event, eventId: 'evt-2' });
  assert.equal((await one('SELECT count(*)::integer AS n FROM operator_settlements')).n, 1);
  assert.ok((await groupSeats(group.id)).every(s => s.status === 'confirmed'));
});

test('market evidence records one fare per traveller, never the party total as one passenger', async () => {
  const group = await hold(3);
  const payment = await pay.initiate(passenger, group.id, {}, randomUUID());
  await pay.applyEvent({ kind: 'payment', paymentId: payment.id, eventId: 'evt-1', reference: await referenceOf(payment.id),
    amountMinor: group.amount_minor+group.service_fee_minor, currency: 'XOF', status: 'succeeded' });
  const observed = await all('SELECT price_minor FROM fare_observations ORDER BY source_reference');
  assert.equal(observed.length, 3, 'three travellers are three observations');
  assert.ok(observed.every(o => o.price_minor === group.perPassengerMinor),
    'each at the fare they paid, so the corridor average is not inflated by the size of the group');
});

test('a refund releases the whole party', async () => {
  const group = await hold(2);
  const payment = await pay.initiate(passenger, group.id, {}, randomUUID());
  await pay.applyEvent({ kind: 'payment', paymentId: payment.id, eventId: 'evt-1', reference: await referenceOf(payment.id),
    amountMinor: group.amount_minor+group.service_fee_minor, currency: 'XOF', status: 'succeeded' });
  await pay.applyEvent({ kind: 'payment', paymentId: payment.id, eventId: 'evt-2', reference: await referenceOf(payment.id),
    amountMinor: group.amount_minor+group.service_fee_minor, currency: 'XOF', status: 'refunded' });
  assert.ok((await groupSeats(group.id)).every(s => s.status === 'cancelled'), 'every seat is released');
  assert.equal((await one('SELECT refunded_minor FROM payments WHERE id=$1',[payment.id])).refunded_minor,group.amount_minor,
    'the operator fare is refunded while the service fee stays retained');
  assert.equal((await one('SELECT count(*)::integer AS n FROM booking_segments')).n, 0, 'and every segment with it');
});

test('a party whose seats lapsed is held for review rather than half-confirmed', async () => {
  const group = await hold(2);
  const payment = await pay.initiate(passenger, group.id, {}, randomUUID());
  // The hold lapses before the provider answers.
  await db.transaction(tx => tx.query("UPDATE bookings SET expires_at=now()-interval '1 minute' WHERE group_id=$1", [group.id]));
  await db.transaction(tx => tx.query('SELECT id FROM services WHERE id=$1 FOR UPDATE', [demo.service]));
  await domain.expireHolds();
  const result = await pay.applyEvent({ kind: 'payment', paymentId: payment.id, eventId: 'evt-1', reference: await referenceOf(payment.id),
    amountMinor: group.amount_minor+group.service_fee_minor, currency: 'XOF', status: 'succeeded' });
  assert.equal(result.reconciliation, 'review', 'a human looks at money taken for seats that are gone');
  assert.ok((await groupSeats(group.id)).every(s => s.status === 'expired'));
});

// ── expiry and tickets ──────────────────────────────────────────────────────

test('expiry releases the purchase and all of its seats together', async () => {
  const group = await hold(3);
  await db.transaction(tx => tx.query("UPDATE bookings SET expires_at=now()-interval '1 minute' WHERE group_id=$1", [group.id]));
  // expireHolds finds the service through either table and sweeps both.
  await domain.expireHolds();
  assert.equal((await one('SELECT status FROM booking_groups WHERE id=$1', [group.id])).status, 'expired');
  assert.equal((await one('SELECT count(*)::integer AS n FROM booking_segments')).n, 0);
  assert.equal((await domain.availability(demo.service, 0, 3)).available, CAPACITY, 'the coach is empty again');
});

test('each traveller gets their own usable ticket', async () => {
  const group = await hold(3);
  const payment = await pay.initiate(passenger, group.id, {}, randomUUID());
  await pay.applyEvent({ kind: 'payment', paymentId: payment.id, eventId: 'evt-1', reference: await referenceOf(payment.id),
    amountMinor: group.amount_minor+group.service_fee_minor, currency: 'XOF', status: 'succeeded' });
  const members = await all('SELECT id,seat_number FROM bookings WHERE group_id=$1 ORDER BY seat_number', [group.id]);
  const issued = [];
  for (const member of members) issued.push(await ticket.issue(passenger, member.id));
  assert.equal(new Set(issued.map(t => t.token)).size, 3, 'three distinct credentials');
  assert.ok(issued.every(t => t.validForBoarding), 'and every one of them opens the door');
  assert.deepEqual(issued.map(t => t.document.seat_number), [1, 2, 3], 'each naming its own seat');
});

// ── buying without an account ───────────────────────────────────────────────

test('a visitor buys with a name and a phone, and receives an access token', async () => {
  const purchase = await guest(null, { serviceId: demo.service, origin: 0, destination: 3, quantity: 2,
    passengerName: 'Awa Sossou', passengerPhone: '+229 97 00 00 42' }, randomUUID());
  assert.equal(purchase.quantity, 2);
  assert.equal(typeof purchase.guestToken, 'string');
  assert.ok(purchase.guestToken.length >= 32);
  const buyer = await one('SELECT * FROM users WHERE id=$1', [purchase.purchaser_id]);
  assert.equal(buyer.auth_subject, null, 'a guest identity can never be signed into');
  assert.equal(buyer.role, 'passenger');
  assert.equal((await one('SELECT phone FROM passenger_profiles WHERE user_id=$1', [buyer.id])).phone, '+229 97 00 00 42');
});

test('a visitor without a name or phone is refused, and nothing is created', async () => {
  const guests = `SELECT id FROM users WHERE auth_subject IS NULL AND role='passenger' AND NOT is_demo`;
  const before = (await one(`SELECT count(*)::integer AS n FROM (${guests}) g`)).n;
  await assert.rejects(guest(null, { serviceId: demo.service, origin: 0, destination: 3, quantity: 1 }, randomUUID()),
    { code: 'INVALID_CONTACT' });
  await assert.rejects(guest(null, { serviceId: demo.service, origin: 0, destination: 3, quantity: 1,
    passengerName: 'A', passengerPhone: '+229 97 00 00 42' }, randomUUID()), { code: 'INVALID_CONTACT' });
  // The identity and the seats are written in one transaction, so a refused
  // purchase leaves neither: no buyer holding nothing, and no seat held by
  // nobody.
  assert.equal((await one(`SELECT count(*)::integer AS n FROM (${guests}) g`)).n, before, 'no buyer was created');
  assert.equal((await one('SELECT count(*)::integer AS n FROM bookings')).n, 0);
  assert.equal((await one('SELECT count(*)::integer AS n FROM api_sessions')).n, 0, 'and no access token was issued');
});

test('a guest who buys again keeps the same identity and gets no second token', async () => {
  const first = await guest(null, { serviceId: demo.service, origin: 0, destination: 3, quantity: 1,
    passengerName: 'Awa Sossou', passengerPhone: '+229 97 00 00 42' }, randomUUID());
  const second = await guest({ id: first.purchaser_id, role: 'passenger' },
    { serviceId: demo.service, origin: 0, destination: 3, quantity: 1 }, randomUUID());
  assert.equal(second.guestToken, null, 'the token they hold is the one they keep');
  assert.equal(second.purchaser_id, first.purchaser_id, 'one guest identity, not one per purchase');
  assert.equal((await one('SELECT count(*)::integer AS n FROM booking_groups')).n, 2);
  assert.equal((await one(`SELECT count(*)::integer AS n FROM api_sessions WHERE user_id=$1`, [first.purchaser_id])).n, 1);
});
