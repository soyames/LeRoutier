// Following a journey with a ticket number and nothing else.
//
// The route-level half of the promise that buying without an account is a real
// way to buy: a traveller who never signed in has to be able to see where their
// bus is, on the day, from a phone, without an identity of any kind. What that
// answer is allowed to contain is the other half, and it is the part worth
// testing hardest — the ticket number is guessable on purpose (eight hex
// characters is a reference a person can read off a ticket), so everything
// behind it has to be safe for a stranger to see.
//
// The rate limit is not decoration either. It is the ONLY thing standing
// between a reference and an enumeration, which is why it is asserted here
// rather than trusted.
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '@leroutier/database';
import { migrate } from '@leroutier/database/migrations';
import { dropDisposableSchema } from '@leroutier/database/guards';
import { seed, demo } from '@leroutier/database/seed';
import { createApi } from '../src/app.js';
import { jwtFixture } from './jwt-fixture.js';

const identity = await jwtFixture('RS256');
const config = { ...serverConfig(), ...identity.config, schema: 'lr_test_' + randomUUID().replaceAll('-', ''),
  demoLogin: true, allowTestInventory: true };
const db = createDatabase(config);
let api;

// Every lookup is made from its OWN client address. The limiter is per address
// and these tests share one process, so a shared address would make the
// ordering of the file decide whether the last test still has budget — a suite
// that fails depending on which test ran first is worse than no suite.
let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter % 250}`;

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, key?: string, token?: string|null, ip?: string }} [options]
 */
const call = async (path, { method = 'GET', body, key, token = null, ip = freshIp() } = {}) => {
  const response = await api(new Request('http://localhost/api/v1' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip,
      ...(token ? { authorization: 'Bearer ' + token } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, ...(await response.json()) };
};

// A buyer with no account anywhere in the picture: the purchase is the whole
// of their identity, and the token it hands back is how they read it later.
const buy = (quantity = 1, extra = {}) => call('/bookings', { method: 'POST', key: randomUUID(),
  body: { serviceId: demo.service, origin: 0, destination: 3, quantity,
    passengerName: 'Awa Sossou', passengerPhone: '+229 97 00 00 42', ...extra } });

const paidPurchase = async (quantity = 1) => {
  const booked = await buy(quantity);
  assert.equal(booked.status, 200, JSON.stringify(booked));
  // Paid through the guest link, which is the only thing that identifies the
  // buyer: there is no account here to pay as.
  const paid = await call(`/bookings/${booked.data.id}/payments/test`,
    { method: 'POST', key: randomUUID(), body: {}, token: booked.data.guestToken });
  assert.equal(paid.status, 200, JSON.stringify(paid));
  return booked.data;
};

/** The eight characters printed as "Référence" on a ticket. */
const referenceOf = bookingId => bookingId.replace(/-/g, '').slice(0, 8).toUpperCase();

before(async () => { await migrate(db); await seed(db, { capacity: 8 }); api = createApi(db, config, identity.resolver); });
beforeEach(async () => {
  await db.transaction(async tx => {
    assert.ok(db.schema.startsWith('lr_test_'));
    await tx.query(`TRUNCATE bookings, booking_segments, booking_passengers, payments,
      outbox, booking_groups, payment_events CASCADE`);
    await tx.query('DELETE FROM api_sessions');
    await tx.query('DELETE FROM request_limits');
    await tx.query("UPDATE services SET current_sequence=0,status='active'");
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

// ── a ticket number is enough ───────────────────────────────────────────────

test('a visitor with no account follows their journey with only the ticket number', async () => {
  const purchase = await paidPurchase(1);
  const reference = referenceOf(purchase.bookings[0].id);

  const answer = await call(`/public/ticket-tracking/${reference}`);
  assert.equal(answer.status, 200, JSON.stringify(answer));
  assert.equal(answer.data.reference, reference);
  assert.equal(answer.data.ticket.status, 'confirmed');
  assert.equal(answer.data.ticket.departureCity, 'Cotonou');
  assert.equal(answer.data.ticket.arrivalCity, 'Parakou');
  assert.equal(answer.data.ticket.boardingSequence, 0);
  assert.equal(answer.data.ticket.destinationSequence, 3);
  // The journey itself: the same operational picture a signed-in passenger
  // gets, built by the same projection.
  assert.ok(answer.data.tracking, 'there is a journey to describe');
  assert.ok(Array.isArray(answer.data.tracking.stops));
  assert.equal(answer.data.tracking.stops.length, 4);
  assert.ok('signal' in answer.data.tracking);
  assert.ok('eta' in answer.data.tracking);
  assert.ok('position' in answer.data.tracking);
});

test('the printed LRB- reference names the same ticket', async () => {
  const purchase = await paidPurchase(1);
  const reference = referenceOf(purchase.bookings[0].id);
  const withPrefix = await call(`/public/ticket-tracking/LRB-${reference}`);
  assert.equal(withPrefix.status, 200, JSON.stringify(withPrefix));
  assert.equal(withPrefix.data.reference, reference);
  // And so does the same thing typed in lower case, because a reference read
  // off a ticket and typed into a phone is not a case-sensitive secret.
  const lower = await call(`/public/ticket-tracking/${reference.toLowerCase()}`);
  assert.equal(lower.status, 200);
  assert.equal(lower.data.reference, reference);
});

test('the public answer holds no passenger, contact, seat, payment or account field', async () => {
  const purchase = await paidPurchase(2);
  const answer = await call(`/public/ticket-tracking/${referenceOf(purchase.bookings[0].id)}`);
  assert.equal(answer.status, 200);
  const body = JSON.stringify(answer.data);

  // The buyer's own details, the other traveller, the money, and every
  // internal handle a ticket is attached to.
  for (const secret of ['Awa Sossou', '+229 97 00 00 42', 'passenger_id', 'passengerName', 'passenger_name',
    'seat_number', 'seatNumber', 'amount_minor', 'payment', 'group_id', 'bookingId', 'booking_id',
    'guestToken', 'auth_subject', 'notification_email', 'phone']) {
    assert.ok(!body.includes(secret), `"${secret}" must never appear in a public tracking answer`);
  }
  // Not even the identifier the reference is a prefix of: the reference is the
  // handle, and handing out the full id would make the reference redundant.
  assert.ok(!body.includes(purchase.bookings[0].id), 'the booking id itself is not published');
  assert.ok(!body.includes(purchase.bookings[1].id), 'nor the other seat on the same purchase');
  // The service id is an internal handle for endpoints that authorize crew.
  assert.ok(!body.includes(demo.service), 'the service id is not published');
});

test('a reference that names no ticket is told apart from one that is not a reference', async () => {
  // Well-formed but unknown: a real answer about a ticket that is not there.
  const unknown = await call('/public/ticket-tracking/DEADBEEF');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.error.code, 'NOT_FOUND');

  // Malformed: somebody mistyped, and telling them "no such ticket" would send
  // them looking for a ticket that was never the problem.
  for (const malformed of ['abc', 'ZZZZZZZZ', '1234567', 'LRB-123', 'a-friend-of-mine']) {
    const answer = await call(`/public/ticket-tracking/${malformed}`);
    assert.equal(answer.status, 400, `${malformed} is not a ticket number`);
    assert.equal(answer.error.code, 'INVALID_REFERENCE');
  }
});

test('seats that are only held are not yet a ticket', async () => {
  const booked = await buy(1);
  const held = referenceOf(booked.data.bookings[0].id);
  // Nobody has paid. There is no ticket, so there is nothing to follow — and
  // the answer says so rather than drawing an empty journey.
  const answer = await call(`/public/ticket-tracking/${held}`);
  assert.equal(answer.status, 404);
  assert.equal(answer.error.code, 'NOT_FOUND');
});

test('a cancelled departure is stated, and no journey is described for it', async () => {
  const purchase = await paidPurchase(1);
  const reference = referenceOf(purchase.bookings[0].id);
  await db.transaction(async tx => {
    await tx.query("UPDATE services SET status='cancelled' WHERE id=$1", [demo.service]);
  });
  const answer = await call(`/public/ticket-tracking/${reference}`);
  assert.equal(answer.status, 200, JSON.stringify(answer));
  assert.equal(answer.data.ticket.serviceStatus, 'cancelled');
  assert.equal(answer.data.tracking, null, 'a departure that will not run has no progress to show');
});

// ── the limit is the defence ────────────────────────────────────────────────

test('ticket lookups are metered per client address, and a flood is refused', async () => {
  const purchase = await paidPurchase(1);
  const reference = referenceOf(purchase.bookings[0].id);
  const ip = '203.0.113.99';
  // Thirty is what a person retyping a reference needs and a script walking
  // four billion values does not.
  for (let i = 0; i < 30; i++) {
    const answer = await call(`/public/ticket-tracking/${reference}`, { ip });
    assert.equal(answer.status, 200, `request ${i + 1} should still be allowed`);
  }
  const refused = await call(`/public/ticket-tracking/${reference}`, { ip });
  assert.equal(refused.status, 429);
  assert.equal(refused.error.code, 'RATE_LIMITED');
  // And the ceiling is per address, not global: somebody else is unaffected.
  assert.equal((await call(`/public/ticket-tracking/${reference}`)).status, 200);
});

test('the limiter is charged before the lookup, so guessing is not free', async () => {
  const ip = '203.0.113.50';
  for (let i = 0; i < 30; i++) {
    // Every one of these is a miss. A limiter that only counted successes
    // would leave the enumeration it exists to stop completely unmetered.
    const answer = await call(`/public/ticket-tracking/${i.toString(16).padStart(8, '0').toUpperCase()}`, { ip });
    assert.equal(answer.status, 404, `miss ${i} is still a metered request`);
  }
  const refused = await call('/public/ticket-tracking/BADBADBA', { ip });
  assert.equal(refused.status, 429);
});
