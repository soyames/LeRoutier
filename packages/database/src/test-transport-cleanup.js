import { assertDisposableSchema } from './guards.js';

// Stable dataset scope AND structural marker. Names/UUIDs alone never
// authorize deletion. Foreign keys fail closed for other usage.
const ids = values => values.map(n => `00000000-0000-4000-b00b-${String(n).padStart(12, '0')}`);
const serviceIds = ids([60,61,62,63,64,65]);

export async function cleanupTestServices(tx) {
  const services = (await tx.query('SELECT id FROM services WHERE id=ANY($1::uuid[]) AND is_demo FOR UPDATE', [serviceIds])).rows.map(r => r.id);
  const bookings = 'SELECT id FROM bookings WHERE service_id=ANY($1::uuid[])';
  await tx.query(`DELETE FROM payment_events WHERE payment_id IN (SELECT id FROM payments WHERE booking_id IN (${bookings}))`, [services]);
  for (const table of ['ticket_credentials','boarding_events','alighting_events','booking_passengers']) {
    await tx.query(`DELETE FROM ${table} WHERE booking_id IN (${bookings})`, [services]);
  }
  await tx.query(`DELETE FROM payments WHERE booking_id IN (${bookings})`, [services]);
  for (const table of ['booking_segments','bookings','vehicle_positions','driver_action_receipts','service_assignments','service_seats','service_segments','service_stops']) {
    await tx.query(`DELETE FROM ${table} WHERE service_id=ANY($1::uuid[])`, [services]);
  }
  await tx.query('DELETE FROM services WHERE id=ANY($1::uuid[]) AND is_demo', [services]);
  return services.length;
}

export async function cleanupTestTransport(db) {
  assertDisposableSchema(db, { purpose: 'TEST transport cleanup' });
  return db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('test-transport-seed'))");
    const removed = await cleanupTestServices(tx);
    const routes = (await tx.query('SELECT id FROM routes WHERE id=ANY($1::uuid[]) AND is_demo', [ids([40,41,42,43,44,45])])).rows.map(r => r.id);
    await tx.query('DELETE FROM route_stops WHERE route_id=ANY($1::uuid[])', [routes]);
    await tx.query('DELETE FROM routes WHERE id=ANY($1::uuid[]) AND is_demo', [routes]);
    await tx.query('DELETE FROM vehicles WHERE id=ANY($1::uuid[]) AND is_demo', [ids([30,31,32,33,34,35])]);
    await tx.query('DELETE FROM stops WHERE id=ANY($1::uuid[]) AND is_demo', [ids([50,51,52,53,54,55,56,57,58])]);
    // Keep identities/operators and immutable audit history. No services
    // remain to expose offers; the structural TEST flag remains intact.
    return removed;
  });
}
