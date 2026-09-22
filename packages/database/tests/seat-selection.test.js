// Choosing a seat, on a service whose capacity is per segment.
//
// The interesting case is the one a route-wide seat counter gets wrong: a seat
// carrying somebody from Cotonou to Bohicon is genuinely free from Bohicon to
// Parakou, and the map has to say so — that spare capacity is the product.
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { transport } from '../src/transport.js';
import { normalizeAmenities, describeAmenities, AMENITY_KEYS } from '../src/amenities.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
const domain = transport(db);
const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));
let passengerA, passengerB;

async function newPassenger() {
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO users(id,auth_subject,auth_issuer,display_name,role,profile_completed_at)
      VALUES($1,$2,'test','Voyageur','passenger',now())`, [id, 'seat-' + id]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)', [id]);
  });
  return { id, role: 'passenger' };
}

before(async () => {
  await migrate(db); await seed(db);
  passengerA = await newPassenger(); passengerB = await newPassenger();
});
beforeEach(async () => {
  await db.transaction(async tx => {
    await tx.query('DELETE FROM booking_segments');
    await tx.query("UPDATE bookings SET status='cancelled'");
    await tx.query("UPDATE services SET current_sequence=0,status='active'");
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('the map lists every seat with its availability for the requested leg', async () => {
  const plan = await domain.seats(demo.service, 0, 1);
  assert.equal(plan.serviceId, demo.service);
  assert.ok(plan.seats.length > 0);
  assert.equal(plan.seats.length, plan.capacity, 'one entry per seat the coach has');
  assert.ok(plan.seats.every(s => s.available), 'an empty service offers every seat');
  assert.ok(plan.seats.every(s => Number.isInteger(s.seatNumber)));
  // Seat numbers are stable and ordered, so the grid does not reshuffle.
  assert.deepEqual(plan.seats.map(s => s.seatNumber), [...plan.seats].sort((a, b) => a.seatNumber - b.seatNumber).map(s => s.seatNumber));
});

test('a chosen seat is honoured, and the same seat cannot be sold twice on one leg', async () => {
  const wanted = (await domain.seats(demo.service, 0, 1)).seats[2].seatNumber;
  const booking = await domain.hold(passengerA, { serviceId: demo.service, origin: 0, destination: 1, seatNumber: wanted }, randomUUID());
  assert.equal(booking.seat_number, wanted, 'the passenger sits where they chose');

  const after = await domain.seats(demo.service, 0, 1);
  assert.equal(after.seats.find(s => s.seatNumber === wanted).available, false);

  // The second passenger is told their seat went, not that the bus is full.
  await assert.rejects(
    domain.hold(passengerB, { serviceId: demo.service, origin: 0, destination: 1, seatNumber: wanted }, randomUUID()),
    error => { assert.equal(error.code, 'SEAT_TAKEN'); assert.equal(error.status, 409); return true; });
  // And can still travel by taking another one.
  const fallback = await domain.hold(passengerB, { serviceId: demo.service, origin: 0, destination: 1 }, randomUUID());
  assert.notEqual(fallback.seat_number, wanted);
});

test('a seat busy on an earlier leg is offered for a later one, and marked as such', async () => {
  const stops = await one('SELECT max(sequence)::integer AS last FROM service_stops WHERE service_id=$1', [demo.service]);
  if (stops.last < 2) return; // the seeded route is too short to prove this
  const wanted = (await domain.seats(demo.service, 0, 1)).seats[0].seatNumber;
  await domain.hold(passengerA, { serviceId: demo.service, origin: 0, destination: 1, seatNumber: wanted }, randomUUID());

  const later = await domain.seats(demo.service, 1, stops.last);
  const seat = later.seats.find(s => s.seatNumber === wanted);
  assert.equal(seat.available, true, 'the seat empties at Bohicon and is sellable onward');
  assert.equal(seat.freedForThisLeg, true, 'and the map says why it is free');
  // It really is bookable, not merely displayed as free.
  const onward = await domain.hold(passengerB, { serviceId: demo.service, origin: 1, destination: stops.last, seatNumber: wanted }, randomUUID());
  assert.equal(onward.seat_number, wanted);
});

test('a seat number that does not exist is refused rather than silently reassigned', async () => {
  await assert.rejects(domain.hold(passengerA, { serviceId: demo.service, origin: 0, destination: 1, seatNumber: 9999 }, randomUUID()),
    { code: 'SEAT_TAKEN' });
  await assert.rejects(domain.hold(passengerA, { serviceId: demo.service, origin: 0, destination: 1, seatNumber: 0 }, randomUUID()),
    { code: 'INVALID_SEAT' });
  await assert.rejects(domain.hold(passengerA, { serviceId: demo.service, origin: 0, destination: 1, seatNumber: 'A1' }, randomUUID()),
    { code: 'INVALID_SEAT' });
});

test('amenities are an operator claim from a closed list, never free text', async () => {
  assert.deepEqual(normalizeAmenities(['wifi', 'air_conditioning']), ['air_conditioning', 'wifi'],
    'stored in catalogue order so one declaration always reads the same');
  assert.deepEqual(normalizeAmenities(['wifi', 'wifi']), ['wifi'], 'duplicates collapse');
  assert.deepEqual(normalizeAmenities(null), []);
  // An unknown value is refused, not dropped: silently discarding it would
  // leave the operator believing they had advertised something.
  assert.throws(() => normalizeAmenities(['massage_chairs']), { code: 'INVALID_AMENITIES' });
  assert.throws(() => normalizeAmenities('wifi'), { code: 'INVALID_AMENITIES' });
  assert.throws(() => normalizeAmenities([{ wifi: true }]), { code: 'INVALID_AMENITIES' });
  // Every stored key can be rendered, so the UI never shows a bare enum.
  for (const entry of describeAmenities(AMENITY_KEYS)) {
    assert.ok(entry.label && entry.short, `${entry.key} has wording`);
  }
  // And the column really accepts what the catalogue produces.
  await db.transaction(async tx => {
    await tx.query('UPDATE vehicles SET amenities=$2 WHERE id=$1', [demo.vehicle, normalizeAmenities(['air_conditioning', 'usb_power'])]);
  });
  const row = await one('SELECT amenities FROM vehicles WHERE id=$1', [demo.vehicle]);
  assert.deepEqual(row.amenities, ['air_conditioning', 'usb_power']);
});
