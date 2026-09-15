import { createHash } from 'node:crypto';
import { DomainError, invariant, journeySegments, validateTransition, uuid, idempotencyKey } from '@leroutier/domain';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const one = async (tx, sql, params = []) => (await tx.query(sql, params)).rows[0];
const emit = (tx, type, id, payload = {}) => tx.query(
  'INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)', [type, id, JSON.stringify(payload)]);

export function transport(db) {
  async function serviceLock(tx, id) {
    const service = await one(tx, 'SELECT * FROM services WHERE id=$1 FOR UPDATE', [uuid(id)]);
    invariant(service, 'NOT_FOUND', 'Service not found.', 404);
    await tx.query(`DELETE FROM booking_segments WHERE booking_id IN
      (SELECT id FROM bookings WHERE service_id=$1 AND status='held' AND expires_at<=now())`, [id]);
    const expired = await tx.query("UPDATE bookings SET status='expired',updated_at=now() WHERE service_id=$1 AND status='held' AND expires_at<=now() RETURNING id", [id]);
    for (const row of expired.rows) await emit(tx, 'booking.expired', row.id);
    return service;
  }
  function ops(actor, service) {
    invariant(actor?.role === 'ops' && (!actor.operator_id || actor.operator_id === service.operator_id),
      'FORBIDDEN', 'Operation is not permitted.', 403);
  }
  async function crew(tx, actor, service) {
    if (actor?.role === 'ops') return ops(actor, service);
    if (actor?.role === 'driver') {
      invariant(await one(tx,
        'SELECT id FROM service_assignments WHERE service_id=$1 AND driver_id=$2 AND ended_at IS NULL', [service.id, actor.id]),
      'FORBIDDEN', 'This service is not assigned to you.', 403);
      return;
    }
    if (actor?.role === 'convoyeur') {
      invariant(await one(tx,
        'SELECT id FROM service_assignments WHERE service_id=$1 AND convoyeur_id=$2 AND ended_at IS NULL', [service.id, actor.id]),
      'FORBIDDEN', 'This service is not assigned to you.', 403);
      return;
    }
    invariant(false, 'FORBIDDEN', 'Crew access required.', 403);
  }
  async function getBooking(tx, id, actor) {
    const b = await one(tx, 'SELECT * FROM bookings WHERE id=$1', [uuid(id)]);
    invariant(b, 'NOT_FOUND', 'Booking not found.', 404);
    const service = await serviceLock(tx, b.service_id);
    if (actor?.role === 'passenger') invariant(actor.id === b.passenger_id, 'FORBIDDEN', 'Booking is not yours.', 403);
    else await crew(tx, actor, service);
    return { booking: await one(tx, 'SELECT * FROM bookings WHERE id=$1', [id]), service };
  }
  async function availability(tx, service, origin, destination) {
    const { rows: stops } = await tx.query(`SELECT ss.sequence,ss.stop_id,s.name,p.name AS city FROM service_stops ss
      JOIN stops s ON s.id=ss.stop_id JOIN places p ON p.id=s.place_id WHERE service_id=$1 ORDER BY sequence`, [service.id]);
    const affected = journeySegments(origin, destination, stops.length);
    const { rows: segments } = await tx.query(`SELECT ss.sequence,ss.fare_minor,count(bs.booking_id)::integer AS occupied
      FROM service_segments ss LEFT JOIN booking_segments bs ON bs.service_id=ss.service_id AND bs.sequence=ss.sequence
      LEFT JOIN bookings b ON b.id=bs.booking_id
      WHERE ss.service_id=$1 GROUP BY ss.sequence,ss.fare_minor ORDER BY ss.sequence`, [service.id]);
    const seats = await one(tx, `SELECT count(*)::integer AS available FROM service_seats seats WHERE service_id=$1 AND NOT EXISTS
      (SELECT 1 FROM booking_segments bs WHERE bs.service_id=seats.service_id AND bs.seat_number=seats.seat_number AND bs.sequence >=$2 AND bs.sequence<$3)`,
    [service.id, origin, destination]);
    return { serviceId: service.id, origin, destination, available: origin < service.current_sequence ? 0 : seats.available,
      capacity: service.capacity, segments: segments.map(s => ({...s, available: service.capacity - s.occupied})), stops,
      fare: { amountMinor: affected.reduce((sum, seq) => sum + segments[seq].fare_minor, 0), currency: 'XOF' } };
  }
  async function txHold(tx, actor, input, key) {
    invariant(actor?.role === 'passenger', 'FORBIDDEN', 'Passenger access required.', 403);
    const { serviceId, origin, destination } = input;
    idempotencyKey(key);
    const hash = fingerprint([serviceId, origin, destination]);
    // Lock idempotency identity before the service: identical requests on different services serialize too.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.id + ':' + key]);
    const service = await serviceLock(tx, serviceId);
    const prior = await one(tx, 'SELECT * FROM bookings WHERE passenger_id=$1 AND idempotency_key=$2', [actor.id, key]);
    if (prior) {
      invariant(prior.request_fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'The key was used for a different request.', 409);
      return prior;
    }
    invariant(['scheduled','active'].includes(service.status) && origin >= service.current_sequence,
      'SERVICE_UNAVAILABLE', 'This journey is no longer open.', 409);
    invariant(service.status === 'active' || new Date(service.departure_at).getTime() > Date.now(),
      'SERVICE_UNAVAILABLE', 'Departure has passed.', 409);
    const quote = await availability(tx, service, origin, destination);
    invariant(quote.available > 0, 'SOLD_OUT', 'No seat is available on every requested segment.', 409);
    const seat = await one(tx, `SELECT seat_number FROM service_seats seats WHERE service_id=$1 AND NOT EXISTS
      (SELECT 1 FROM booking_segments bs WHERE bs.service_id=seats.service_id AND bs.seat_number=seats.seat_number AND bs.sequence >=$2 AND bs.sequence<$3)
      ORDER BY seat_number LIMIT 1`, [serviceId, origin, destination]);
    const booking = await one(tx, `INSERT INTO bookings(service_id,passenger_id,origin_sequence,destination_sequence,seat_number,status,amount_minor,expires_at,idempotency_key,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,'held',$6,now()+interval '10 minutes',$7,$8) RETURNING *`,
    [serviceId, actor.id, origin, destination, seat.seat_number, quote.fare.amountMinor, key, hash]);
    await tx.query('INSERT INTO booking_passengers(booking_id,passenger_id) VALUES($1,$2)', [booking.id, actor.id]);
    await tx.query(`INSERT INTO booking_segments(booking_id,service_id,seat_number,sequence)
      SELECT $1,$2,$3,generate_series($4::integer,$5::integer-1)`, [booking.id, serviceId, seat.seat_number, origin, destination]);
    await emit(tx, 'booking.held', booking.id, { serviceId });
    return booking;
  }
  async function txTransition(tx, actor, id, action, stopSequence = undefined) {
    const { booking: b, service } = await getBooking(tx, id, actor);
    invariant(actor?.role !== 'driver' || ['board','alight'].includes(action), 'FORBIDDEN', 'Operation is not permitted.', 403);
    if (['board','alight'].includes(action)) {
      await crew(tx, actor, service);
      invariant(service.status === 'active', 'SERVICE_UNAVAILABLE', 'Service must be active.', 409);
      invariant(stopSequence === service.current_sequence && stopSequence === (action === 'board' ? b.origin_sequence : b.destination_sequence),
        'WRONG_STOP', 'This action must happen at the booked stop.', 409);
    }
    const target = { confirm:'confirmed',cancel:'cancelled',board:'boarded',alight:'completed' }[action];
    invariant(target, 'INVALID_ACTION', 'Unknown booking action.');
    if (b.status === target) return b;
    const next = validateTransition(b.status, action);
    if (action === 'confirm') {
      invariant(['scheduled','active'].includes(service.status) && b.origin_sequence>=service.current_sequence &&
        (service.status==='active' || new Date(service.departure_at)>new Date()),'SERVICE_UNAVAILABLE','Service is no longer open for confirmation.',409);
      const paid = await one(tx, "SELECT coalesce(sum(amount_minor),0)::integer AS amount FROM payments WHERE booking_id=$1 AND status='succeeded'", [id]);
      invariant(paid.amount === b.amount_minor, 'PAYMENT_REQUIRED', 'A verified payment record is required.', 409);
    }
    if (action === 'cancel' || action === 'alight') await tx.query('DELETE FROM booking_segments WHERE booking_id=$1', [id]);
    if (action === 'board' || action === 'alight') {
      const table = action === 'board' ? 'boarding_events' : 'alighting_events';
      await tx.query(`INSERT INTO ${table}(booking_id,actor_id,stop_sequence) VALUES($1,$2,$3)`, [id, actor.id, stopSequence]);
    }
    const result = await one(tx, 'UPDATE bookings SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [id, next]);
    await emit(tx, 'booking.' + next, id);
    if (action === 'cancel') await emit(tx, 'payment.refund_review', id);
    return result;
  }
  return {
    async availability(id, origin, destination) {
      return db.transaction(async tx => availability(tx, await serviceLock(tx, id), origin, destination));
    },
    async hold(actor, input, key) {
      return db.transaction(async tx => txHold(tx, actor, input, key));
    },
    // Transaction-level entry points: walk-up sales and other composite
    // flows reuse the exact same domain logic inside their own transaction
    // (no nested connection, no self-deadlock).
    txHold,
    txTransition,
    async booking(actor, id) { return db.transaction(async tx => (await getBooking(tx, id, actor)).booking); },
    async passengerBookings(actor) {
      invariant(actor?.role === 'passenger', 'FORBIDDEN', 'Passenger access required.', 403);
      // Expiry is also enforced by the worker and every service operation.
      return db.transaction(async tx => {
        const { rows } = await tx.query('SELECT DISTINCT service_id FROM bookings WHERE passenger_id=$1 ORDER BY service_id', [actor.id]);
        for (const row of rows) await serviceLock(tx, row.service_id);
        return (await tx.query(`SELECT b.*,r.name AS route_name,s.departure_at,s.departure_point_id,s.arrival_point_id,
          bdp.name AS departure_point_name,bdp.description AS departure_point_landmark,bdp.latitude AS departure_point_latitude,bdp.longitude AS departure_point_longitude,
          bap.name AS arrival_point_name,bap.description AS arrival_point_landmark,bap.latitude AS arrival_point_latitude,bap.longitude AS arrival_point_longitude,
          op.name AS departure_city,ap.name AS arrival_city
          FROM bookings b JOIN services s ON s.id=b.service_id JOIN routes r ON r.id=s.route_id
          LEFT JOIN boarding_points bdp ON bdp.id=s.departure_point_id LEFT JOIN places op ON op.id=bdp.place_id
          LEFT JOIN boarding_points bap ON bap.id=s.arrival_point_id LEFT JOIN places ap ON ap.id=bap.place_id
          WHERE passenger_id=$1 ORDER BY b.created_at DESC LIMIT 100`, [actor.id])).rows;
      });
    },
    async transition(actor, id, action, stopSequence = undefined) {
      return db.transaction(async tx => txTransition(tx, actor, id, action, stopSequence));
    },
    async recordPayment(actor, id, input, key) {
      idempotencyKey(key);
      invariant(Number.isInteger(input.amountMinor) && input.amountMinor >= 0 && input.currency === 'XOF' &&
        ['cash','bank_transfer','demo'].includes(input.provider) && typeof input.reference === 'string' && input.reference.length <= 100 && input.reference.length > 0,
      'INVALID_PAYMENT', 'Payment record is invalid.');
      const hash = fingerprint([id,input.amountMinor,input.currency,input.provider,input.reference]);
      return db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['payment:' + key]);
        const { booking: b, service } = await getBooking(tx, id, actor);
        ops(actor, service);
        invariant(input.provider !== 'demo' || service.is_demo, 'INVALID_PAYMENT', 'Demo payment is only allowed on demo services.');
        const prior = await one(tx, 'SELECT * FROM payments WHERE idempotency_key=$1', [key]);
        if (prior) { invariant(prior.request_fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'The key was used for another payment.', 409); return prior; }
        invariant(b.status === 'held' && b.amount_minor === input.amountMinor, 'INVALID_PAYMENT', 'Payment does not match an active hold.', 409);
        invariant(!await one(tx,"SELECT id FROM payments WHERE booking_id=$1 AND status='pending'",[id]),'PAYMENT_PENDING','Reconcile the pending provider payment before recording another payment.',409);
        invariant(!await one(tx, "SELECT id FROM payments WHERE booking_id=$1 AND status='succeeded'", [id]), 'ALREADY_PAID', 'Payment already recorded.', 409);
        const payment = await one(tx, `INSERT INTO payments(booking_id,provider,provider_reference,amount_minor,currency,status,idempotency_key,request_fingerprint,recorded_by)
          VALUES($1,$2,$3,$4,$5,'succeeded',$6,$7,$8) RETURNING *`, [id,input.provider,input.reference,input.amountMinor,'XOF',key,hash,actor.id]);
        await emit(tx, 'payment.recorded', payment.id, { bookingId:id });
        return payment;
      });
    },
    async manifest(actor, serviceId) {
      return db.transaction(async tx => {
        const service = await serviceLock(tx, serviceId);
        await crew(tx, actor, service);
        return (await tx.query('SELECT * FROM manifests WHERE service_id=$1 ORDER BY origin_sequence,seat_number', [serviceId])).rows;
      });
    },
    async advance(actor, serviceId, sequence) {
      return db.transaction(async tx => {
        const service = await serviceLock(tx, serviceId);
        await crew(tx, actor, service);
        invariant(service.status === 'active' && Number.isInteger(sequence) && sequence === service.current_sequence+1 &&
          await one(tx, 'SELECT 1 FROM service_stops WHERE service_id=$1 AND sequence=$2', [serviceId, sequence]), 'INVALID_STOP', 'Advance to the next stop only.', 409);
        invariant(!await one(tx, "SELECT id FROM bookings WHERE service_id=$1 AND status='boarded' AND destination_sequence<$2", [serviceId,sequence]),
          'ALIGHTING_REQUIRED', 'Complete alighting before leaving the stop.', 409);
        const result = await one(tx, 'UPDATE services SET current_sequence=$2,updated_at=now() WHERE id=$1 RETURNING *', [serviceId,sequence]);
        await emit(tx,'service.advanced',serviceId,{sequence});
        return result;
      });
    },
    async expireHolds() {
      return db.transaction(async tx => {
        const { rows } = await tx.query("SELECT DISTINCT service_id FROM bookings WHERE status='held' AND expires_at<=now() ORDER BY service_id");
        for (const row of rows) await serviceLock(tx, row.service_id);
        return { servicesProcessed:rows.length };
      });
    },
    async authorizeService(tx, actor, serviceId, opsOnly = false) {
      const service = await serviceLock(tx, serviceId);
      if (opsOnly) ops(actor, service); else await crew(tx, actor, service);
      return service;
    },
  };
}

export { DomainError };
