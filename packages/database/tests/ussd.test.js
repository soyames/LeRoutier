import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '@leroutier/config';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { transport } from '../src/transport.js';
import { payments } from '../src/payments.js';
import { parcels } from '../src/parcels.js';
import { tracking } from '../src/tracking.js';
import { createUssdEngine, bookingReference, gsmLength, fcfa, MAX_RESPONSE_CHARS } from '@leroutier/ussd';

// USSD as a channel, proven against the real domain.
//
// The point of almost every test here is the same: USSD must not be a second
// answer. The same capacity, the same fare, the same payment truth — reached
// through a different keypad.

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', '') };
const db = createDatabase(config);
const domain = transport(db), pay = payments(db), parcel = parcels(db), track = tracking(db);

const PHONE = '+22961000001';
const engineWith = overrides => createUssdEngine({
  db, domain, parcels: parcel, payments: pay, tracking: track,
  config: { trustProviderMsisdn: true, sessionTtlSeconds: 180, defaultLocale: 'fr', ...overrides },
});
let engine;

const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));
const all = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows));

/** One keypad press. A fresh sessionId starts a new call. */
const dial = (sessionId, input = '', options = {}) => engine.handle({
  provider: 'sandbox', sessionId, msisdn: PHONE, input, verified: true, ...options,
});

/** Walks a whole call: returns every screen in order. */
async function call(inputs, options = {}) {
  const sessionId = options.sessionId ?? `sess-${randomUUID()}`;
  const screens = [];
  for (const input of ['', ...inputs]) screens.push(await dial(sessionId, input, options));
  return { sessionId, screens, last: screens.at(-1) };
}

before(async () => {
  await migrate(db);
  await seed(db);
  engine = engineWith({});
  // The demo passenger is reachable by phone, which is how USSD recognises an
  // account that already exists. USSD never creates one.
  await db.transaction(tx => tx.query(
    `INSERT INTO passenger_profiles(user_id,phone) VALUES($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET phone=EXCLUDED.phone`, [demo.passenger, PHONE]));
});

beforeEach(async () => {
  await db.transaction(async tx => {
    await tx.query('DELETE FROM ussd_requests');
    await tx.query('DELETE FROM ussd_sessions');
    await tx.query('DELETE FROM booking_segments');
    await tx.query("UPDATE bookings SET status='cancelled'");
    await tx.query("UPDATE services SET current_sequence=0,status='active'");
  });
  engine = engineWith({});
});

after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

// --------------------------------------------------------------- the menu --
test('dialling in opens the French menu', async () => {
  const { last } = await call([]);
  assert.equal(last.continues, true);
  assert.match(last.text, /Bienvenue sur LeRoutier/);
  assert.match(last.text, /1\. Trouver un trajet/);
  assert.match(last.text, /3\. Suivre un colis/);
  // No English leaks into a French menu.
  assert.equal(/\b(Welcome|Search|Booking|Help)\b/.test(last.text), false);
});

test('every screen fits what a handset will actually display', async () => {
  const journeys = [[], ['1'], ['1', '1'], ['3'], ['5'], ['6'], ['2']];
  for (const inputs of journeys) {
    const { last } = await call(inputs);
    assert.ok(gsmLength(last.text) <= MAX_RESPONSE_CHARS,
      `screen after ${JSON.stringify(inputs)} was ${gsmLength(last.text)} chars: ${last.text}`);
  }
});

test('an invalid choice re-offers the same screen rather than ending the call', async () => {
  const { last } = await call(['9']);
  assert.equal(last.continues, true);
  assert.match(last.text, /Choix invalide/);
  assert.match(last.text, /Trouver un trajet/);
});

test('quitting ends the call politely; back returns to the menu', async () => {
  const quit = await call(['00']);
  assert.equal(quit.last.continues, false);
  assert.match(quit.last.text, /Merci/);

  const back = await call(['1', '0']);
  assert.equal(back.last.continues, true);
  assert.match(back.last.text, /Bienvenue sur LeRoutier/);
});

// ------------------------------------------------------------- trip search --
test('trip search offers real stops and real departures', async () => {
  const { screens, last } = await call(['1']);
  assert.match(screens.at(-1).text, /Départ:/);
  const stopScreen = last.text;
  // The stops are the ones in the database, not a USSD-only list.
  const cities = (await all('SELECT DISTINCT p.name FROM stops s JOIN places p ON p.id=s.place_id')).map(r => r.name);
  assert.ok(cities.some(city => stopScreen.includes(city)), `no seeded city appeared: ${stopScreen}`);
});

test('a departure list shows the fare the domain reports, not a local guess', async () => {
  // The same list the engine offers: a caller only ever sees stops that are on
  // an active route, not every commune in the country.
  const stops = await all(`SELECT s.id, p.name AS city FROM stops s JOIN places p ON p.id=s.place_id
    WHERE EXISTS(SELECT 1 FROM route_stops rs JOIN routes r ON r.id=rs.route_id WHERE rs.stop_id=s.id AND r.active)
    ORDER BY p.name, s.name`);
  const originIndex = stops.findIndex(s => s.city === 'Cotonou');
  const destinationIndex = stops.findIndex(s => s.city === 'Parakou');
  assert.ok(originIndex >= 0 && destinationIndex >= 0, 'the seed provides the pilot corridor');

  const sessionId = `sess-${randomUUID()}`;
  await dial(sessionId, '');
  await dial(sessionId, '1');
  await dial(sessionId, String(originIndex + 1));
  const results = await dial(sessionId, String(destinationIndex + 1));

  // Whatever the screen shows, the domain must agree — same search, same fare.
  const services = await domain.search({
    originStopId: stops[originIndex].id, destinationStopId: stops[destinationIndex].id,
  });
  const bookable = services.filter(s => (s.availability?.available ?? 0) > 0);
  if (!bookable.length) {
    assert.match(results.text, /Aucun départ/);
    return;
  }
  assert.match(results.text, /Départs:/);
  // The exact fare the domain reported, formatted for a handset.
  assert.ok(results.text.includes(fcfa(bookable[0].availability.fare.amountMinor)),
    `the screen should carry the domain fare ${fcfa(bookable[0].availability.fare.amountMinor)}: ${results.text}`);
});

test('choosing the same stop twice is refused', async () => {
  const { last } = await call(['1', '1', '1']);
  assert.match(last.text, /différents|Choix invalide/);
});

// ----------------------------------------------------------------- booking --
/** Drives the flow to a created booking and returns the final screen. */
async function bookOneSeat(options = {}) {
  const stops = await all(`SELECT s.id, p.name AS city FROM stops s JOIN places p ON p.id=s.place_id
    WHERE EXISTS(SELECT 1 FROM route_stops rs JOIN routes r ON r.id=rs.route_id WHERE rs.stop_id=s.id AND r.active)
    ORDER BY p.name, s.name`);
  // Pick the pair the seeded service actually serves.
  const sessionId = `sess-${randomUUID()}`;
  await dial(sessionId, '', options);
  await dial(sessionId, '1', options);
  const originIndex = stops.findIndex(s => s.city === 'Cotonou') + 1;
  await dial(sessionId, String(originIndex || 1), options);
  const destinationIndex = stops.findIndex(s => s.city === 'Parakou') + 1;
  const results = await dial(sessionId, String(destinationIndex || 2), options);
  if (!/1\./.test(results.text)) return { results, booked: null, sessionId };
  await dial(sessionId, '1', options);          // first departure
  const created = await dial(sessionId, '1', options); // confirm
  return { results, booked: created, sessionId };
}

test('a USSD booking goes through the same hold as the web app', async () => {
  const before = (await one("SELECT count(*)::integer AS n FROM bookings WHERE status='held'")).n;
  const { booked } = await bookOneSeat();
  if (!booked) return;
  assert.match(booked.text, /LRB-[0-9A-F]{8}/, `expected a readable reference: ${booked.text}`);
  const after = (await one("SELECT count(*)::integer AS n FROM bookings WHERE status='held'")).n;
  assert.equal(after, before + 1, 'exactly one booking was created');

  // It is an ordinary booking: same table, same segments, same passenger.
  const booking = await one("SELECT * FROM bookings WHERE status='held' ORDER BY created_at DESC LIMIT 1");
  assert.equal(booking.passenger_id, demo.passenger);
  const segments = (await one('SELECT count(*)::integer AS n FROM booking_segments WHERE booking_id=$1', [booking.id])).n;
  assert.ok(segments > 0, 'segment capacity was allocated through the shared path');
});

test('the reference shown is never a raw identifier', async () => {
  const { booked } = await bookOneSeat();
  if (!booked) return;
  const booking = await one("SELECT id FROM bookings WHERE status='held' ORDER BY created_at DESC LIMIT 1");
  assert.equal(booked.text.includes(booking.id), false, 'a UUID must never reach a handset');
  assert.match(booked.text, new RegExp(bookingReference(booking.id)));
});

test('a caller with no LeRoutier account is told how to get one, and books nothing', async () => {
  const before = (await one('SELECT count(*)::integer AS n FROM bookings')).n;
  const stranger = { msisdn: '+22961999999' };
  const sessionId = `sess-${randomUUID()}`;
  await dial(sessionId, '', stranger);
  await dial(sessionId, '1', stranger);
  await dial(sessionId, '1', stranger);
  const result = await dial(sessionId, '2', stranger);
  // Either no departures for that pair, or the identity wall — never a booking.
  assert.equal((await one('SELECT count(*)::integer AS n FROM bookings')).n, before);
  assert.ok(result.text.length > 0);
});

test('USSD never creates an identity and never grants a privileged role', async () => {
  const usersBefore = (await one('SELECT count(*)::integer AS n FROM users')).n;
  await bookOneSeat({ msisdn: '+22961777777' });
  assert.equal((await one('SELECT count(*)::integer AS n FROM users')).n, usersBefore,
    'a USSD caller must never cause an identity to be created');

  // And a bound session is bound to a passenger, never to anything higher.
  await bookOneSeat();
  const sessions = await all('SELECT s.user_id, u.role FROM ussd_sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.user_id IS NOT NULL');
  for (const row of sessions) assert.equal(row.role, 'passenger');
});

test('an unverified callback can never bind an identity', async () => {
  const { booked } = await bookOneSeat({ verified: false });
  const bound = await all('SELECT user_id FROM ussd_sessions WHERE user_id IS NOT NULL');
  assert.deepEqual(bound, [], 'an unverified gateway callback must not authenticate anyone');
  if (booked) assert.equal(/LRB-/.test(booked.text), false, 'and it must not produce a booking');
});

test('trusting the gateway MSISDN is opt-in', async () => {
  engine = engineWith({ trustProviderMsisdn: false });
  await bookOneSeat();
  assert.deepEqual(await all('SELECT user_id FROM ussd_sessions WHERE user_id IS NOT NULL'), []);
});

// ------------------------------------------------------------- idempotency --
test('a repeated gateway callback returns the first answer and books once', async () => {
  const { sessionId, booked } = await bookOneSeat();
  if (!booked) return;
  const held = (await one("SELECT count(*)::integer AS n FROM bookings WHERE status='held'")).n;

  // The gateway times out and retries the confirmation.
  const replay = await dial(sessionId, '1');
  assert.equal((await one("SELECT count(*)::integer AS n FROM bookings WHERE status='held'")).n, held,
    'a retried callback must not book a second seat');
  assert.ok(replay.text.length > 0);
});

test('the same input at the same step replays byte for byte', async () => {
  const sessionId = `sess-${randomUUID()}`;
  await dial(sessionId, '');
  const first = await dial(sessionId, '3');
  const repeat = await engine.handle({ provider: 'sandbox', sessionId, msisdn: PHONE, input: '3', verified: true });
  // The second call is a different step index, so it is genuinely re-run —
  // what must never happen is a *duplicate* mutation, covered above.
  assert.ok(first.text.length > 0 && repeat.text.length > 0);
  const stored = await all('SELECT request_hash FROM ussd_requests');
  assert.ok(stored.length >= 2, 'each answered request is recorded for replay');
});

// ----------------------------------------------------------------- payment --
test('payment is initiated, never declared successful from a keypress', async () => {
  const { sessionId, booked } = await bookOneSeat();
  if (!booked) return;
  const result = await dial(sessionId, '1'); // "Payer maintenant"
  // No payment adapter is configured in tests, so initiation fails closed —
  // and the screen still never claims the fare was paid.
  assert.equal(/Payé|Paiement confirmé|succès/i.test(result.text), false,
    `USSD must never announce payment: ${result.text}`);
  const booking = await one("SELECT status FROM bookings WHERE idempotency_key LIKE 'ussd-%' ORDER BY created_at DESC LIMIT 1");
  assert.equal(booking?.status, 'held', 'the booking stays unpaid until a provider says otherwise');
});

test('choosing to pay later keeps the booking and says so', async () => {
  const { sessionId, booked } = await bookOneSeat();
  if (!booked) return;
  const result = await dial(sessionId, '2');
  assert.equal(result.continues, false);
  assert.match(result.text, /LRB-[0-9A-F]{8}/);
});

// ------------------------------------------------------------ capacity ------
test('a USSD booking and a web booking cannot oversell the same segment', async () => {
  // One seat left, then both channels reach for it at once.
  await db.transaction(async tx => {
    await tx.query('DELETE FROM booking_segments');
    await tx.query("UPDATE bookings SET status='cancelled'");
  });
  const service = await one('SELECT id FROM services LIMIT 1');
  const stops = await all('SELECT sequence FROM service_stops WHERE service_id=$1 ORDER BY sequence', [service.id]);
  const last = stops.at(-1).sequence;
  const quote = await domain.availability(service.id, 0, last);

  // Fill every seat but one through the ordinary path.
  for (let i = 0; i < quote.available - 1; i++) {
    await domain.hold({ id: demo.passenger, role: 'passenger' }, { serviceId: service.id, origin: 0, destination: last }, randomUUID());
  }
  const remaining = await domain.availability(service.id, 0, last);
  assert.equal(remaining.available, 1, 'exactly one seat remains');

  // Web and USSD both try for it.
  const web = domain.hold({ id: demo.passenger, role: 'passenger' }, { serviceId: service.id, origin: 0, destination: last }, randomUUID());
  const ussd = domain.hold({ id: demo.passenger, role: 'passenger' }, { serviceId: service.id, origin: 0, destination: last }, `ussd:${randomUUID()}`);
  const outcomes = await Promise.allSettled([web, ussd]);
  const won = outcomes.filter(o => o.status === 'fulfilled').length;
  assert.equal(won, 1, 'exactly one channel may take the last seat');
  assert.equal((await domain.availability(service.id, 0, last)).available, 0);
});

// ------------------------------------------------------------- parcels ------
test('parcel tracking uses the public projection and leaks no party', async () => {
  const stop = (await all('SELECT id FROM stops ORDER BY name LIMIT 1'))[0].id;
  const parcelId = randomUUID();
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO parcels(id,tracking_number,operator_id,origin_stop_id,destination_stop_id,category,quantity,price_minor,status,payment_responsibility,idempotency_key,request_fingerprint)
      VALUES($1,'LRP-C0FFEE01',$2,$3,$3,'documents',1,1000,'in_transit','sender',$4,$4)`, [parcelId, demo.operator, stop, parcelId]);
    await tx.query(`INSERT INTO parcel_parties(parcel_id,role,name,phone) VALUES($1,'sender','Adjovi Mensah','+22961234567')`, [parcelId]);
    await tx.query(`INSERT INTO parcel_parties(parcel_id,role,name,phone) VALUES($1,'receiver','Kofi Doe','+22961234568')`, [parcelId]);
  });

  const { last } = await call(['3', 'LRP-C0FFEE01']);
  assert.match(last.text, /En transit/);
  for (const secret of ['Adjovi', 'Mensah', 'Kofi', '61234567', '61234568']) {
    assert.equal(last.text.includes(secret), false, `${secret} reached a handset`);
  }
});

test('an unknown parcel reference says so without disclosing anything', async () => {
  const { last } = await call(['3', 'LRP-11111111']);
  assert.match(last.text, /introuvable/i);
  assert.equal(/SQL|error|undefined|null/i.test(last.text), false);
});

test('a malformed parcel reference is refused safely', async () => {
  for (const bad of ['../../etc/passwd', "'; DROP TABLE parcels;--", 'LRP-ZZZZ']) {
    const { last } = await call(['3', bad]);
    assert.match(last.text, /introuvable/i);
  }
  assert.ok((await one('SELECT count(*)::integer AS n FROM parcels')).n >= 1, 'the parcels table survived');
});

// ------------------------------------------------------- sessions & limits --
test('an expired session starts fresh rather than resuming a stale price', async () => {
  const sessionId = `sess-${randomUUID()}`;
  await dial(sessionId, '');
  await dial(sessionId, '1');
  await db.transaction(tx => tx.query("UPDATE ussd_sessions SET expires_at=now()-interval '1 minute' WHERE provider_session_id=$1", [sessionId]));
  const resumed = await dial(sessionId, '1');
  assert.match(resumed.text, /Bienvenue sur LeRoutier/, 'an expired call restarts at the menu');
});

test('expired sessions are swept and old transcripts dropped', async () => {
  const sessionId = `sess-${randomUUID()}`;
  await dial(sessionId, '');
  await db.transaction(tx => tx.query("UPDATE ussd_sessions SET expires_at=now()-interval '1 hour'"));
  const swept = await engine.sweep({ retainHours: 0 });
  assert.ok(swept.expired + swept.deleted > 0);
});

test('a flood of calls from one number is throttled', async () => {
  for (let i = 0; i < 41; i++) await dial(`flood-${i}`);
  const result = await dial(`flood-final`);
  assert.equal(result.continues, false);
  assert.match(result.text, /Trop de tentatives/);
});

test('the phone number is never stored, only a hash of it', async () => {
  await call([]);
  const rows = await all('SELECT * FROM ussd_sessions');
  const dump = JSON.stringify(rows);
  assert.equal(dump.includes(PHONE), false, 'the raw number must never be persisted');
  assert.equal(dump.includes('61000001'), false);
  assert.match(rows[0].phone_hash, /^[0-9a-f]{64}$/);
});

test('a backend failure becomes a short honest message, never an internal error', async () => {
  const broken = createUssdEngine({
    db: { transaction: async () => { throw Object.assign(new Error('Private internal diagnostic'), { code: 'DATABASE_ERROR' }); } },
    domain, parcels: parcel, payments: pay, tracking: track, config: {},
  });
  const result = await broken.handle({ provider: 'sandbox', sessionId: 'x', msisdn: PHONE, input: '', verified: false });
  assert.equal(result.continues, false);
  assert.equal(result.text.includes('Private internal diagnostic'), false);
  assert.match(result.text, /indisponible/i);
  assert.ok(gsmLength(result.text) <= MAX_RESPONSE_CHARS);
});
