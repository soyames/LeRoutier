import { invariant, uuid } from '@leroutier/domain';
import { transport } from './transport.js';
import { audit } from './identities.js';

const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const emit = (tx, type, id, payload = {}) => tx.query(
  'INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)', [type, id, JSON.stringify(payload)]);

// Breakdown recovery: shared by the human Ops API and the agentic recovery
// workflow — one implementation, one transport, no duplicated business logic.
export function recovery(db) {
  const domain = transport(db);
  return {
    async eligibleVehicles(actor, serviceId, capacity) {
      return db.transaction(async tx => {
        const service = await domain.authorizeService(tx, actor, serviceId);
        return (await tx.query(`SELECT v.* FROM vehicles v WHERE v.operator_id=$1 AND v.status='active' AND v.capacity>=$2
          AND NOT EXISTS(SELECT 1 FROM service_assignments a WHERE a.vehicle_id=v.id AND a.ended_at IS NULL) ORDER BY v.capacity`,
        [service.operator_id, capacity])).rows;
      });
    },
    async affectedPassengers(actor, serviceId, fromSequence) {
      return db.transaction(async tx => {
        const service = await domain.authorizeService(tx, actor, serviceId);
        const row = await one(tx, `SELECT count(*)::integer AS count FROM bookings WHERE service_id=$1 AND status IN ('held','confirmed','boarded') AND destination_sequence>$2`,
          [service.id, fromSequence]);
        return { count: row?.count ?? 0 };
      });
    },
    async assign(actor, input) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      uuid(input.vehicleId); uuid(input.driverId); uuid(input.incidentId);
      return db.transaction(async tx => {
        const s = await domain.authorizeService(tx, actor, input.serviceId, true);
        invariant(['active', 'disrupted'].includes(s.status), 'INVALID_TRANSITION', 'Service is not recoverable.', 409);
        invariant((await tx.query("SELECT id FROM incidents WHERE id=$1 AND service_id=$2 AND status<>'resolved'", [input.incidentId, s.id])).rowCount, 'INVALID_INCIDENT', 'An open incident on this service is required.');
        const v = (await tx.query("SELECT * FROM vehicles WHERE id=$1 AND operator_id=$2 AND status='active' FOR UPDATE", [input.vehicleId, s.operator_id])).rows[0];
        invariant(v && v.capacity >= s.capacity, 'INSUFFICIENT_REPLACEMENT', 'Replacement must support every existing seat.', 409);
        invariant((await tx.query('SELECT user_id FROM driver_profiles WHERE user_id=$1 AND operator_id=$2 AND active=true', [input.driverId, s.operator_id])).rowCount, 'INVALID_DRIVER', 'Driver is not available for this operator.');
        const prior = (await tx.query('SELECT id FROM service_assignments WHERE service_id=$1 AND ended_at IS NULL', [s.id])).rows[0];
        invariant(prior, 'INVALID_ASSIGNMENT', 'Current assignment is missing.', 409);
        await tx.query('UPDATE service_assignments SET ended_at=now() WHERE id=$1', [prior.id]);
        const replacement = (await tx.query('INSERT INTO service_assignments(service_id,vehicle_id,driver_id) VALUES($1,$2,$3) RETURNING id', [s.id, input.vehicleId, input.driverId])).rows[0];
        const result = (await tx.query(`INSERT INTO recovery_assignments(service_id,incident_id,previous_assignment_id,replacement_assignment_id,from_sequence,actor_id)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [s.id, input.incidentId, prior.id, replacement.id, s.current_sequence, actor.id])).rows[0];
        await emit(tx, 'service.recovery', s.id, { recoveryId: result.id });
        await audit(tx, actor.id, 'service.recovery_assigned', result.id, s.operator_id, { serviceId: s.id, vehicleId: input.vehicleId, driverId: input.driverId });
        return result;
      });
    },
  };
}
