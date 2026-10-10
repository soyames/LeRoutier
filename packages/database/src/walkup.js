import { createHash } from 'node:crypto';
import { invariant, uuid, idempotencyKey, priceWithServiceFee } from '@leroutier/domain';
import { transport } from './transport.js';
import { operatorSettlements } from './operator-settlements.js';
import { fareIntelligence } from './fare-intelligence.js';
import { audit } from './identities.js';

// Walk-up cash bookings: the ONLY cash channel. Authorized crew (Driver or
// Convoyeur assigned to the service) sells a seat for cash, records the
// payment against the booking and credits the operator's settlement ledger.
// Passenger online checkout never accepts cash — that rule is unchanged.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function walkUpBookings(db) {
  const domain = transport(db);
  const settlements = operatorSettlements(db);
  const fares = fareIntelligence(db);
  return async function create(actor, input, key) {
    invariant(actor?.role === 'driver' || actor?.role === 'convoyeur' || actor?.role === 'cashier', 'FORBIDDEN', 'Crew or authorized cashier access required.', 403);
    idempotencyKey(key);
    invariant(input && Object.keys(input).every(k => ['serviceId', 'origin', 'destination', 'passengerName', 'passengerPhone', 'amountMinor', 'cashReference'].includes(k)),
      'INVALID_WALKUP', 'Unexpected walk-up fields.');
    uuid(input.serviceId);
    invariant(Number.isInteger(input.origin) && Number.isInteger(input.destination) && input.origin >= 0 && input.origin < input.destination,
      'INVALID_JOURNEY', 'Choose an origin before the destination.');
    invariant(typeof input.passengerName === 'string' && input.passengerName.trim().length >= 2 && input.passengerName.length <= 100,
      'INVALID_WALKUP', 'Passenger name is required.');
    invariant(typeof input.passengerPhone === 'string' && /^\+?[0-9 ()-]{6,25}$/.test(input.passengerPhone), 'INVALID_WALKUP', 'Passenger phone is required.');
    invariant(Number.isInteger(input.amountMinor) && input.amountMinor > 0, 'INVALID_WALKUP', 'Amount is invalid.');
    invariant(typeof input.cashReference === 'string' && input.cashReference.trim().length > 0 && input.cashReference.length <= 100,
      'INVALID_WALKUP', 'A receipt reference is required.');
    const fingerprint = digest([actor.id, input.serviceId, input.origin, input.destination, input.amountMinor, input.cashReference]);
    return db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['walk-up:' + actor.id + ':' + key]);
      // Idempotency receipt (audit is append-only, so reuse its trail).
      const prior = await one(tx, "SELECT * FROM audit_events WHERE actor_id=$1 AND action='booking.walkup_sold' AND details->>'key'=$2", [actor.id, key]);
      if (prior) {
        invariant(prior.details.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Key was used for another sale.', 409);
        const booking = await one(tx, 'SELECT * FROM bookings WHERE id=$1', [prior.details.bookingId]);
        const replayPrice=priceWithServiceFee(booking.amount_minor);
        return { bookingId: booking.id, replayed: true, fareMinor:replayPrice.fareMinor,
          serviceFeeMinor:replayPrice.serviceFeeMinor,amountMinor: replayPrice.totalMinor };
      }
      const service = await one(tx, 'SELECT * FROM services WHERE id=$1 FOR UPDATE', [input.serviceId]);

      invariant(service, 'NOT_FOUND', 'Service not found.', 404);
      // Drivers and convoyeurs must be assigned to the trip. A cashier is
      // authorized only inside their own company and can never sell for an
      // independent driver or another operator.
      if(actor.role==='cashier') {
        invariant(actor.operator_id===service.operator_id &&
          await one(tx,"SELECT id FROM operators WHERE id=$1 AND type='company'",[service.operator_id]),
        'FORBIDDEN','Ce compte caisse ne peut vendre que pour sa compagnie.',403);
      } else if (actor.role === 'driver') {
        invariant(await one(tx, 'SELECT id FROM service_assignments WHERE service_id=$1 AND driver_id=$2 AND ended_at IS NULL', [service.id, actor.id]),
          'FORBIDDEN', 'This service is not assigned to you.', 403);
      } else {
        invariant(await one(tx, 'SELECT id FROM service_assignments WHERE service_id=$1 AND convoyeur_id=$2 AND ended_at IS NULL', [service.id, actor.id]),
          'FORBIDDEN', 'This service is not assigned to you.', 403);
      }
      const saleWindow=actor.role==='cashier'?['scheduled','active'].includes(service.status):service.status==='active';
      invariant(saleWindow && input.origin >= service.current_sequence, 'SERVICE_UNAVAILABLE', 'Walk-up sales are closed for this stop.', 409);
      // Guest passenger identity: walk-up passengers never sign in.
      const guest = await one(tx, `INSERT INTO users(display_name,role) VALUES($1,'passenger') RETURNING id`, [input.passengerName.trim()]);

      await tx.query('INSERT INTO passenger_profiles(user_id,phone) VALUES($1,$2)', [guest.id, input.passengerPhone.trim()]);
      // Reuse the authoritative hold/availability logic for the guest identity.
      const booking = await domain.txHold(tx, { id: guest.id, role: 'passenger' }, { serviceId: service.id, origin: input.origin, destination: input.destination }, key);

      invariant(booking.amount_minor === input.amountMinor, 'INVALID_WALKUP', 'Amount does not match the segment fare.', 409);
      // Cash payment recorded by the crew, then confirmation — the same
      // trusted path Ops uses at the counter.
      const pricing=priceWithServiceFee(booking.amount_minor);
      await tx.query(`INSERT INTO payments(booking_id,provider,provider_reference,amount_minor,fare_minor,service_fee_minor,currency,status,idempotency_key,request_fingerprint,recorded_by)
        VALUES($1,'cash',$2,$3,$4,$5,'XOF','succeeded',$6,$7,$8)`,
      [booking.id, input.cashReference.trim(), pricing.totalMinor, pricing.fareMinor, pricing.serviceFeeMinor, 'walkup:' + key, digest([booking.id, 'cash', input.cashReference.trim()]), actor.id]);
      const confirmed = await domain.txTransition(tx, { id: guest.id, role: 'passenger' }, booking.id, 'confirm');

      // The operator receives the fare they set. The 2% service fee is charged
      // on top and recorded separately; cash sales follow the same rule.
      // TEST/demo services are excluded: synthetic sales never move real
      // settlement ledgers or become market evidence.
      if (!service.is_demo) {
        await settlements.credit(tx, { operatorId: service.operator_id, source: 'walk_up', reference: 'walkup:' + booking.id,
          grossMinor: pricing.fareMinor, deductionMinor: 0, payoutState:'direct' });
        await tx.query(`INSERT INTO operator_cash_fees(operator_id,booking_id,fare_minor,fee_minor,cash_received_minor,recorded_by)
          VALUES($1,$2,$3,$4,$5,$6)`,[service.operator_id,booking.id,pricing.fareMinor,pricing.serviceFeeMinor,pricing.totalMinor,actor.id]);
        // The completed cash sale is also market evidence for its corridor.
        const od = await one(tx, `SELECT o.stop_id AS origin_stop_id,d.stop_id AS destination_stop_id,op.type AS operator_type
          FROM service_stops o JOIN service_stops d ON d.service_id=o.service_id AND d.sequence=$3
          JOIN operators op ON op.id=$2 WHERE o.service_id=$1 AND o.sequence=$4`,
        [service.id, service.operator_id, input.destination, input.origin]);
        if (od) await fares.recordTransaction(tx, { operatorId: service.operator_id, originStopId: od.origin_stop_id,
          destinationStopId: od.destination_stop_id, routeId: service.route_id, fareType: 'passenger', priceMinor: input.amountMinor,
          operatorType: od.operator_type, sourceReference: 'walkup:' + booking.id, observedAt: new Date().toISOString() });
      }
      await audit(tx, actor.id, 'booking.walkup_sold', booking.id, service.operator_id, {
        key, fingerprint, bookingId: booking.id, serviceId: service.id, amountMinor: pricing.totalMinor,
        fareMinor:pricing.fareMinor,serviceFeeMinor:pricing.serviceFeeMinor,role: actor.role, guestPassengerId: guest.id,
      });
      return { bookingId: booking.id, status: confirmed.status, fareMinor:pricing.fareMinor,
        serviceFeeMinor:pricing.serviceFeeMinor, amountMinor:pricing.totalMinor, cashReference: input.cashReference.trim() };
    });
  };
}
