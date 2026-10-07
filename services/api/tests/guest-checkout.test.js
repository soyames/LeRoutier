// Buying a ticket through the API, with and without an account.
//
// The route-level half of the product rule. The domain suite proves the money
// and the seats; this one proves the door: that a visitor with no Authorization
// header reaches the booking handler at all, that a guest can read back what
// they bought with the token it handed them, and that an account cannot buy as
// itself until a purchase has made it a passenger account.
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

/**
 * A request as a bearer token, as a guest token, or as nobody at all.
 * @param {string|null} token
 * @param {string} path
 * @param {{ method?: string, body?: unknown, key?: string }} [options]
 */
const call = async (token, path, { method = 'GET', body, key } = {}) => {
  const response = await api(new Request('http://localhost/api/v1' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, ...(await response.json()) };
};

/** @param {string} path @param {{ method?: string, body?: unknown, key?: string }} [options] */
const asVisitor = (path, options) => call(null, path, options);
const trip = { serviceId: demo.service, origin: 0, destination: 3 };
const buy = (quantity, extra = {}) => asVisitor('/bookings', { method: 'POST', key: randomUUID(),
  body: { ...trip, quantity, passengerName: 'Awa Sossou', passengerPhone: '+229 97 00 00 42', ...extra } });

before(async () => { await migrate(db); await seed(db, { capacity: 8 }); api = createApi(db, config, identity.resolver); });
beforeEach(async () => {
  await db.transaction(async tx => {
    assert.ok(db.schema.startsWith('lr_test_'));
    await tx.query(`TRUNCATE bookings, booking_segments, booking_passengers, payments,
      outbox, booking_groups, payment_events CASCADE`);
    await tx.query('DELETE FROM api_sessions');
    await tx.query("UPDATE services SET current_sequence=0,status='active'");
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

// ── no account required ─────────────────────────────────────────────────────

test('a visitor books two tickets with no Authorization header at all', async () => {
  const booked = await buy(2);
  assert.equal(booked.status, 200);
  assert.equal(booked.data.quantity, 2);
  assert.equal(booked.data.bookings.length, 2, 'one booking per traveller');
  assert.equal(booked.data.amount_minor, booked.data.perPassengerMinor * 2);
  assert.equal(typeof booked.data.guestToken, 'string', 'and an access token comes back exactly once');
  assert.equal(booked.data.bookings.every(b => b.group_id === booked.data.id), true);
});

test('the guest token is what reads the purchase back, and nothing else is', async () => {
  const booked = await buy(2);
  const token = booked.data.guestToken;
  const mine = await call(token, '/me/bookings');
  assert.equal(mine.status, 200);
  assert.equal(mine.data.length, 2);

  // No token, a made-up token, and the booking id used as a token.
  assert.equal((await asVisitor('/me/bookings')).status, 401);
  assert.equal((await call('not-a-real-token-at-all', '/me/bookings')).status, 401);
  assert.equal((await call(booked.data.id, '/me/bookings')).status, 401);
});

test('a ticket is issued only once the purchase is paid, then for every traveller', async () => {
  const booked = await buy(2);
  const token = booked.data.guestToken;
  // Holding seats is not paying for them, and a guest gets no more latitude
  // than anybody else: the ticket is refused while the purchase is unpaid.
  const early = await call(token, `/bookings/${booked.data.bookings[0].id}/ticket`, { method: 'POST', body: {} });
  assert.equal(early.status, 409);
  assert.equal(early.error.code, 'TICKET_INVALID');

  const paid = await call(token, `/bookings/${booked.data.id}/payments/test`, { method: 'POST', key: randomUUID(), body: {} });
  assert.equal(paid.status, 200, JSON.stringify(paid));
  assert.equal(paid.data.amount_minor, booked.data.amount_minor, 'one charge, for the whole party');

  const tickets = [];
  for (const seat of booked.data.bookings) {
    const ticket = await call(token, `/bookings/${seat.id}/ticket`, { method: 'POST', body: {} });
    assert.equal(ticket.status, 200, JSON.stringify(ticket));
    assert.equal(ticket.data.validForBoarding, true);
    tickets.push(ticket.data);
  }
  assert.equal(new Set(tickets.map(t => t.token)).size, 2, 'two travellers, two credentials');
  assert.deepEqual(tickets.map(t => t.document.seat_number).sort((a, b) => a - b),
    booked.data.bookings.map(b => b.seat_number).sort((a, b) => a - b));
  // And the whole party reads back as confirmed.
  const mine = await call(token, '/me/bookings');
  assert.equal(mine.data.every(b => b.status === 'confirmed'), true);
});

test('a guest purchase still needs somebody to contact, and a name is not a phone', async () => {
  assert.equal((await buy(1, { passengerName: 'A' })).status, 400);
  assert.equal((await buy(1, { passengerPhone: '123' })).status, 400);
  const missing = await asVisitor('/bookings', { method: 'POST', key: randomUUID(), body: { ...trip, quantity: 1 } });
  assert.equal(missing.status, 400);
  assert.equal(missing.error.code, 'INVALID_CONTACT');
});

test('a quantity the coach cannot seat is refused, and a quantity beyond ten never gets there', async () => {
  const before = (await asVisitor('/bookings', { method: 'POST', key: randomUUID(),
    body: { ...trip, quantity: 6, passengerName: 'Awa Sossou', passengerPhone: '+229 97 00 00 42' } }));
  assert.equal(before.status, 200);
  const tooMany = await buy(3);
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.error.code, 'SOLD_OUT');
  // Ten is the product ceiling; eleven is not a capacity problem.
  const absurd = await buy(11);
  assert.equal(absurd.status, 400);
  assert.equal(absurd.error.code, 'INVALID_QUANTITY');
});

test('a fare that moved since the quote is refused, and the seats are not held', async () => {
  const stale = await buy(2, { expectedAmountMinor: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.error.code, 'FARE_CHANGED');
  const nothing = await db.transaction(async tx => (await tx.query('SELECT count(*)::integer AS n FROM booking_groups')).rows[0]);
  assert.equal(nothing.n, 0);
});

// ── an account is what comes after ──────────────────────────────────────────

test('a brand-new account cannot buy as itself, and is told what to do instead', async () => {
  const token = await identity.sign('newcomer-' + randomUUID());
  const me = await call(token, '/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.passenger_activated, false, 'it is an account, not yet a passenger account');
  const refused = await call(token, '/bookings', { method: 'POST', key: randomUUID(),
    body: { ...trip, quantity: 1 } });
  assert.equal(refused.status, 403);
  assert.equal(refused.error.code, 'PASSENGER_NOT_ACTIVATED');
});

test('adopting a purchase is what turns the account into a passenger account', async () => {
  const booked = await buy(2);
  const guest = booked.data.guestToken;
  assert.equal((await call(guest, `/bookings/${booked.data.id}/payments/test`, { method: 'POST', key: randomUUID(), body: {} })).status, 200);
  const token = await identity.sign('buyer-' + randomUUID());
  assert.equal((await call(token, '/bookings', { method: 'POST', key: randomUUID(), body: { ...trip, quantity: 1 } })).status, 403);

  const claimed = await call(token, '/me/claim', { method: 'POST', body: { guestToken: booked.data.guestToken } });
  assert.equal(claimed.status, 200, JSON.stringify(claimed));
  assert.equal(claimed.data.tickets, 2);

  const me = await call(token, '/me');
  assert.equal(me.data.passenger_activated, true);
  const mine = await call(token, '/me/bookings');
  assert.equal(mine.data.length, 2, 'the tickets are on the account now');
  // Buying as itself still needs a completed profile — the rule that was already
  // there for every passenger, and the purchase does not quietly waive it.
  assert.equal((await call(token, '/bookings', { method: 'POST', key: randomUUID(), body: { ...trip, quantity: 1 } })).status, 409);
  const profiled = await call(token, '/me', { method: 'PATCH', body: { displayName: 'Awa Sossou', phone: '+229 97 00 00 42' } });
  assert.equal(profiled.status, 200);
  const bookedAsSelf = await call(token, '/bookings', { method: 'POST', key: randomUUID(), body: { ...trip, quantity: 1 } });
  assert.equal(bookedAsSelf.status, 200, 'and it buys as itself, on its own account');
  assert.equal(bookedAsSelf.data.bookings.length, 1);
});

test('a spent token cannot be adopted twice', async () => {
  const booked = await buy(1);
  assert.equal((await call(booked.data.guestToken, `/bookings/${booked.data.id}/payments/test`,
    { method: 'POST', key: randomUUID(), body: {} })).status, 200);
  const first = await identity.sign('first-' + randomUUID());
  assert.equal((await call(first, '/me/claim', { method: 'POST', body: { guestToken: booked.data.guestToken } })).status, 200);
  const second = await identity.sign('second-' + randomUUID());
  const replayed = await call(second, '/me/claim', { method: 'POST', body: { guestToken: booked.data.guestToken } });
  assert.equal(replayed.status, 401);
  assert.equal(replayed.error.code, 'CLAIM_INVALID');
});

test('adopting requires a session, not merely a token', async () => {
  const booked = await buy(1);
  const anonymous = await asVisitor('/me/claim', { method: 'POST', body: { guestToken: booked.data.guestToken } });
  assert.equal(anonymous.status, 401);
  // And a rejected claim leaves the purchase exactly where it was.
  const stillThere = await call(booked.data.guestToken, '/me/bookings');
  assert.equal(stillThere.data.length, 1);
});

// ── the provider boundary ───────────────────────────────────────────────────
//
// A driver and a transport company are service providers. Nothing about the
// passenger work may stand between them and their account, their dossier or
// their plan — and nothing they do as providers may put them through the
// passenger checkout or charge them a passenger fare.

const proof = name => `https://documents.example.invalid/${name}.pdf`;
const INDEPENDENT = { displayName: 'Chauffeur Test', phone: '+229 97110022', country: 'BJ',
  idDocumentType: 'national_id', idDocumentReference: 'CNI-2026-01', licenseReference: 'PERMIS-2026-01',
  transportAuthorizationReference: 'AUT-2026-01', insuranceReference: 'ASSUR-2026-01',
  roadworthinessReference: 'TECH-2026-01', vehicleRegistration: 'AB-1234-CD', vehicleCapacity: 14,
  vehicleMake: 'Toyota', vehicleModel: 'Hiace', vehicleColor: 'Blanc',
  idDocumentUrl: proof('identite'), licenseDocumentUrl: proof('permis'), driverPhotoUrl: proof('photo-chauffeur'),
  transportAuthorizationDocumentUrl: proof('autorisation'), insuranceDocumentUrl: proof('assurance'),
  roadworthinessDocumentUrl: proof('visite-technique'), vehicleRegistrationDocumentUrl: proof('carte-grise') };
const COMPANY = { displayName: 'Compagnie Test', legalName: 'Compagnie Test SARL', contactPhone: '+229 97220033',
  country: 'BJ', registrationRef: 'RCCM-2026-01', taxReference: 'IFU-2026-01',
  representativeName: 'Représentant Test', representativeIdReference: 'CNI-2026-02',
  transportAuthorizationReference: 'AUT-2026-02', registeredAddress: 'Cotonou, quartier Ganhi',
  registrationDocumentUrl: proof('rccm'), taxDocumentUrl: proof('ifu'),
  representativeIdDocumentUrl: proof('identite-representant'),
  transportAuthorizationDocumentUrl: proof('autorisation-compagnie'), addressProofUrl: proof('adresse') };

/** A fresh identity, signed in and with a completed profile, ready to onboard. */
async function newProvider(subject, plate) {
  const token = await identity.sign(subject + '-' + randomUUID());
  assert.equal((await call(token, '/me')).status, 200);
  assert.equal((await call(token, '/me', { method: 'PATCH', body: { displayName: 'Chauffeur Test', phone: '+229 97110022' } })).status, 200);
  return { token, dossier: { ...INDEPENDENT, vehicleRegistration: plate } };
}

const nothingWasSold = async () => {
  const counts = await db.transaction(async tx => (await tx.query(`SELECT
    (SELECT count(*)::integer FROM bookings) AS bookings,
    (SELECT count(*)::integer FROM booking_groups) AS purchases,
    (SELECT count(*)::integer FROM payments) AS payments`)).rows[0]);
  assert.deepEqual(counts, { bookings: 0, purchases: 0, payments: 0 },
    'a provider doing provider work buys nothing and is charged nothing');
};

test('a driver onboards through the provider flow with no ticket anywhere in it', async () => {
  const { token, dossier } = await newProvider('driver-candidate', 'AB-1234-CD');
  const onboarded = await call(token, '/onboarding/independent', { method: 'POST', body: dossier, key: randomUUID() });
  assert.equal(onboarded.status, 200, JSON.stringify(onboarded));
  assert.equal(onboarded.data.role, 'driver');
  await nothingWasSold();

  // And the account works for the work it was made for.
  const me = await call(token, '/me');
  assert.equal(me.data.role, 'driver');
  assert.equal(me.data.operator_id, onboarded.data.operatorId);
  const membership = await call(token, '/onboarding/me');
  assert.equal(membership.data.membership.operatorId, onboarded.data.operatorId);
  assert.equal(membership.data.membership.role, 'driver');
});

test('a transport company onboards, and reads its subscription, with no ticket anywhere in it', async () => {
  const token = await identity.sign('company-candidate-' + randomUUID());
  assert.equal((await call(token, '/me')).status, 200);
  await call(token, '/me', { method: 'PATCH', body: { displayName: 'Compagnie Test', phone: '+229 97220033' } });
  const onboarded = await call(token, '/onboarding/company', { method: 'POST', body: COMPANY, key: randomUUID() });
  assert.equal(onboarded.status, 200, JSON.stringify(onboarded));
  assert.equal(onboarded.data.role, 'ops');
  await nothingWasSold();

  // The subscription is its own flow, on its own record. Providing transport
  // does not go through the checkout and does not incur a passenger fare.
  const plan = await call(token, '/ops/plan');
  assert.equal(plan.status, 200, JSON.stringify(plan));
  assert.equal(plan.data.operatorType, 'company');
  assert.ok(plan.data.subscription && 'billingStatus' in plan.data.subscription);
  assert.equal(plan.data.commissionBp, 500);
  await nothingWasSold();
});

test('a provider buys a ticket as a guest, and the purchase cannot be moved onto its account', async () => {
  const { token, dossier } = await newProvider('driver-buyer', 'EF-5678-GH');
  const onboarded = await call(token, '/onboarding/independent', { method: 'POST', body: dossier, key: randomUUID() });
  assert.equal(onboarded.status, 200, JSON.stringify(onboarded));

  // Their provider account cannot buy as itself — buying tickets is the
  // passenger journey — so the purchase is a guest purchase, exactly as it is
  // for anybody else who is not a passenger account.
  const withoutContact = await call(token, '/bookings', { method: 'POST', key: randomUUID(), body: { ...trip, quantity: 1 } });
  assert.equal(withoutContact.status, 400, 'a guest purchase still needs somebody to contact');

  const bought = await call(token, '/bookings', { method: 'POST', key: randomUUID(),
    body: { ...trip, quantity: 1, passengerName: 'Chauffeur Test', passengerPhone: '+229 97110022' } });
  assert.equal(bought.status, 200, JSON.stringify(bought));
  assert.equal(typeof bought.data.guestToken, 'string');
  const purchase = bought.data;

  // It is theirs to use, through the link it came with.
  assert.equal((await call(purchase.guestToken, '/me/bookings')).data.length, 1);

  // And it cannot be adopted by the driver account. Nothing about a ticket may
  // grant provider standing, so nothing about a provider account may be the
  // thing a ticket is adopted into.
  const claimed = await call(token, '/me/claim', { method: 'POST', body: { guestToken: purchase.guestToken } });
  assert.equal(claimed.status, 403);
  assert.equal(claimed.error.code, 'FORBIDDEN');
  const me = await call(token, '/me');
  assert.equal(me.data.role, 'driver', 'the role is untouched');
  assert.equal(me.data.operator_id, onboarded.data.operatorId, 'and so is the operator it is bound to');
  assert.equal(me.data.passenger_activated, false, 'a ticket cannot make a provider account a passenger account');
  const stillTheirs = await call(purchase.guestToken, '/me/bookings');
  assert.equal(stillTheirs.data.length, 1, 'and the ticket stayed exactly where it was');
});

// ── reading a purchase ──────────────────────────────────────────────────────

test('a purchase and a single booking are both readable by id', async () => {
  const booked = await buy(2);
  const token = booked.data.guestToken;
  const purchase = await call(token, `/bookings/${booked.data.id}`);
  assert.equal(purchase.status, 200);
  assert.equal(purchase.data.bookings.length, 2);
  const seat = await call(token, `/bookings/${booked.data.bookings[0].id}`);
  assert.equal(seat.status, 200);
  assert.equal(seat.data.seat_number, booked.data.bookings[0].seat_number);
  // Somebody else's, on either path, is not readable.
  const stranger = await identity.sign('stranger-' + randomUUID());
  assert.equal((await call(stranger, `/bookings/${booked.data.id}`)).status, 403);
  assert.equal((await call(stranger, `/bookings/${booked.data.bookings[0].id}`)).status, 403);
});
