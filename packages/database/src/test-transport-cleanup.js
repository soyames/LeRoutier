import { invariant } from '@leroutier/domain';
import { assertDisposableSchema } from './guards.js';

// Stable dataset scope AND structural marker. Names/UUIDs alone never
// authorize deletion. Foreign keys fail closed for other usage.
const ids = values => values.map(n => `00000000-0000-4000-b00b-${String(n).padStart(12, '0')}`);
const serviceIds = ids([60,61,62,63,64,65]);

// Everything that points at a booking, deleted before the bookings are.
const BOOKING_CHILDREN = ['ticket_credentials','boarding_events','alighting_events',
  'booking_passengers','mobility_handoff_events','operator_cash_fees'];
// Everything that points at a service. `recovery_assignments` precedes
// `incidents` because it points at those too.
//
// `booking_groups` follows `bookings` rather than leading it: it is the purchase
// the bookings belong to, so the seats have to go before the order they were
// bought in, or the seats' own foreign key blocks the delete.
const SERVICE_CHILDREN = ['booking_segments','bookings','booking_groups','vehicle_positions','driver_action_receipts',
  'service_assignments','service_seats','service_segments','service_stops',
  'parcel_custody','parcel_events','parcel_service_assignments','recovery_assignments','incidents'];
// Handled by their own parent's delete, or by the database.
const HANDLED_ELSEWHERE = ['payments','payment_events','operator_ratings'];

/**
 * A hand-written delete order rots: a migration adds a table pointing at
 * `bookings`, nobody updates this file, and the seed keeps working until the
 * day something actually writes that table — after which re-seeding fails
 * forever with a foreign key error naming a table nobody connected to this
 * list. That is exactly how `mobility_handoff_events` got missed.
 *
 * So the order stays explicit and reviewable, and the catalogue is asked
 * whether the list is still complete. A seed path may fail loudly; it may not
 * fail confusingly.
 */
async function assertDeleteOrderIsComplete(tx) {
  const { rows } = await tx.query(`
    SELECT DISTINCT tc.table_name AS child
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name=tc.constraint_name AND rc.constraint_schema=tc.constraint_schema
    WHERE tc.constraint_type='FOREIGN KEY'
      AND tc.table_schema=current_schema()
      AND ccu.table_name IN ('bookings','services')
      AND rc.delete_rule <> 'CASCADE'
      AND tc.table_name <> ccu.table_name`);
  const known = new Set([...BOOKING_CHILDREN, ...SERVICE_CHILDREN, ...HANDLED_ELSEWHERE]);
  const missing = rows.map(r => r.child).filter(name => !known.has(name));
  // invariant, not `throw new Error`: db.transaction converts any other error
  // into a bare DATABASE_ERROR to keep database internals out of responses, so
  // a plain throw here would arrive as the same unreadable failure this guard
  // exists to replace.
  invariant(!missing.length, 'TEST_CLEANUP_INCOMPLETE',
    `TEST cleanup does not know how to clear ${missing.join(', ')}, which now reference bookings or `
    + 'services. Add each one to test-transport-cleanup.js in dependency order.', 500);
}

export async function cleanupTestServices(tx) {
  await assertDeleteOrderIsComplete(tx);
  const services = (await tx.query('SELECT id FROM services WHERE id=ANY($1::uuid[]) AND is_demo FOR UPDATE', [serviceIds])).rows.map(r => r.id);
  const bookings = 'SELECT id FROM bookings WHERE service_id=ANY($1::uuid[])';
  // A payment settles a seat or a purchase, so both attributions are cleared.
  // Deleting only the seat-level ones would leave a purchase payment behind and
  // the next delete of `booking_groups` would fail on it.
  const paid = `SELECT id FROM payments WHERE booking_id IN (${bookings})
    OR group_id IN (SELECT id FROM booking_groups WHERE service_id=ANY($1::uuid[]))`;
  await tx.query(`DELETE FROM payment_events WHERE payment_id IN (${paid})`, [services]);
  await tx.query(`DELETE FROM operator_cash_fee_collections WHERE cash_fee_id IN (SELECT id FROM operator_cash_fees WHERE booking_id IN (${bookings}))`, [services]);
  await tx.query(`DELETE FROM operator_reversal_allocations WHERE reversal_id IN (SELECT id FROM operator_settlement_reversals WHERE payment_id IN (${paid}))`, [services]);
  await tx.query(`DELETE FROM operator_settlement_reversals WHERE payment_id IN (${paid})`, [services]);
  for (const table of BOOKING_CHILDREN) {
    await tx.query(`DELETE FROM ${table} WHERE booking_id IN (${bookings})`, [services]);
  }
  await tx.query(`DELETE FROM payments WHERE id IN (${paid})`, [services]);
  for (const table of SERVICE_CHILDREN) {
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
