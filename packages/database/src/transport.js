import { createHash } from 'node:crypto';
import { DomainError, invariant, journeySegments, validateTransition, uuid, idempotencyKey, priceWithServiceFee } from '@leroutier/domain';
import { audit } from './identities.js';
import { publicRating } from './ratings.js';
import { describeAmenities } from './amenities.js';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const one = async (tx, sql, params = []) => (await tx.query(sql, params)).rows[0];
const emit = (tx, type, id, payload = {}) => tx.query(
  'INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)', [type, id, JSON.stringify(payload)]);

/** The most tickets one purchase may cover. */
export const MAX_GROUP_QUANTITY = 10;

/**
 * Every seat of a purchase is still holdable: all held, on a service that is
 * open and has not left the boarding stop.
 *
 * Checked together and never per seat. A purchase is paid for once and confirmed
 * as a whole, so "midway" is not a state that may exist — and the way to make it
 * impossible is to ask the question about the party before touching any member.
 *
 * @param {{status:string,current_sequence:number,departure_at:string|Date}} service
 * @param {Array<{status:string,origin_sequence:number}>} bookings
 */
export const holdsOpen = (service, bookings) =>
  bookings.length > 0 &&
  bookings.every(b => b.status === 'held') &&
  ['scheduled', 'active'].includes(service.status) &&
  bookings.every(b => b.origin_sequence >= service.current_sequence) &&
  (service.status === 'active' || new Date(service.departure_at).getTime() > Date.now());

/**
 * The money side of a booking, in one place.
 *
 * A seat is paid for either by its own payment or by its purchase's: a
 * single-ticket checkout writes one payment against the booking, a group
 * purchase writes ONE payment against the whole purchase. Every rule that asks
 * "has this been paid for" — the confirmation guard, the ticket, the passenger's
 * own document — has to give the same answer, because the ways they can disagree
 * are a ticket that boards without money and a booking that can never confirm.
 *
 * `dueMinor` is what the payment was actually made against. For a group member
 * that is the PURCHASE total, not the member's own fare: the customer paid once,
 * for the whole party, and comparing one seat's fare against that payment is how
 * a group would be permanently unconfirmable.
 *
 * `paidMinor` is GROSS RECEIVED, which is why it includes money that was later
 * refunded. It answers "how much came in", and `refundedMinor` answers "how much
 * went back"; together they say whether the whole price came and went, which is
 * what a cancellation document exists to show. Netting them into `paidMinor`
 * instead would report a fully refunded booking as having had nothing paid —
 * true of the balance, and false of what happened.
 *
 * @param {{query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>}} tx
 * @param {{id:string,amount_minor:number,group_id?:string|null,service_fee_minor?:number}} booking
 */
export async function bookingMoney(tx, booking) {
  const sums = `SELECT
    coalesce(sum(amount_minor) FILTER (WHERE status IN ('succeeded','refunded')),0)::integer AS paid,
    coalesce(sum(LEAST(refunded_minor,amount_minor)),0)::integer AS refunded`;
  const own = await one(tx, `${sums} FROM payments WHERE booking_id=$1`, [booking.id]);
  const group = booking.group_id
    ? await one(tx, `${sums} FROM payments WHERE group_id=$1`, [booking.group_id])
    : { paid: 0, refunded: 0 };
  const purchase = booking.group_id
    ? await one(tx, 'SELECT amount_minor,service_fee_minor FROM booking_groups WHERE id=$1', [booking.group_id])
    : null;
  const paidMinor = own.paid + group.paid;
  const refundedMinor = own.refunded + group.refunded;
  const fareMinor = booking.group_id ? (purchase?.amount_minor ?? 0) : booking.amount_minor;
  // Fee is stored with the hold so existing tickets keep their old total and
  // a quote cannot change between booking and payment.
  const dueMinor = fareMinor + (booking.group_id ? (purchase?.service_fee_minor ?? 0) : (booking.service_fee_minor ?? 0));
  return { paidMinor, refundedMinor, dueMinor, settled: paidMinor - refundedMinor === dueMinor };
}

/**
 * A member booking's own idempotency key.
 *
 * The key a customer's request carries cannot be reused across the N rows one
 * purchase writes — the booking table is unique on (passenger, key) — so each
 * member derives a stable one from the purchase it belongs to. Stable matters:
 * a retried request that somehow reached the insert would collide rather than
 * duplicate. The purchase row, not these, is what makes the request idempotent.
 */
const memberKey = (groupId, seatNumber) => `group-${groupId}-${seatNumber}`;

export function transport(db) {
  async function serviceLock(tx, id) {
    const service = await one(tx, 'SELECT * FROM services WHERE id=$1 FOR UPDATE', [uuid(id)]);
    invariant(service, 'NOT_FOUND', 'Service not found.', 404);
    await tx.query(`DELETE FROM booking_segments WHERE booking_id IN
      (SELECT id FROM bookings WHERE service_id=$1 AND status='held' AND expires_at<=now())`, [id]);
    const expired = await tx.query("UPDATE bookings SET status='expired',updated_at=now() WHERE service_id=$1 AND status='held' AND expires_at<=now() RETURNING id", [id]);
    for (const row of expired.rows) await emit(tx, 'booking.expired', row.id);
    // The purchase expires with its seats, in the same transaction. Left alone it
    // would stay 'held' for ever, and its expiry would go on disagreeing with the
    // seats it no longer holds — which is a purchase that still accepts a payment
    // for capacity that has already been released.
    //
    // A purchase also expires when it has no held seats left, however its own
    // timestamp reads. The two are written together and ought to agree, but a
    // purchase is judged by the seats it actually holds, and that is the fact
    // worth deriving the status from.
    const expiredGroups = await tx.query(`UPDATE booking_groups g SET status='expired',updated_at=now()
      WHERE g.service_id=$1 AND g.status='held' AND (g.expires_at<=now() OR NOT EXISTS
        (SELECT 1 FROM bookings b WHERE b.group_id=g.id AND b.status='held')) RETURNING g.id`, [id]);
    for (const row of expiredGroups.rows) await emit(tx, 'booking_group.expired', row.id);
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
  /**
   * Every seat on a service, with whether it is free for ONE span.
   *
   * Availability is per segment, so a seat is not simply taken: it is taken
   * between two stops. A seat occupied Cotonou->Bohicon is genuinely free for
   * Bohicon->Parakou, and the map says so rather than greying it out, because
   * that spare capacity is the product.
   */
  async function seatMap(tx, service, origin, destination) {
    const { rows } = await tx.query(`SELECT seats.seat_number,
      EXISTS(SELECT 1 FROM booking_segments bs WHERE bs.service_id=seats.service_id
        AND bs.seat_number=seats.seat_number AND bs.sequence>=$2 AND bs.sequence<$3) AS taken,
      EXISTS(SELECT 1 FROM booking_segments bs WHERE bs.service_id=seats.service_id
        AND bs.seat_number=seats.seat_number) AS busy_elsewhere
      FROM service_seats seats WHERE seats.service_id=$1 ORDER BY seats.seat_number`,
    [service.id, origin, destination]);
    const closed = origin < service.current_sequence;
    return rows.map(row => ({
      seatNumber: row.seat_number,
      available: !closed && !row.taken,
      // Free for this leg while carrying somebody on another part of the
      // route: shown differently so a passenger understands why a busy coach
      // still has seats for them.
      freedForThisLeg: !closed && !row.taken && row.busy_elsewhere,
    }));
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
    // A chosen seat is honoured when it is genuinely free across every segment
    // of this journey; otherwise the first seat that is. The same predicate
    // decides both, inside the transaction holding the service lock, so two
    // passengers choosing the same seat cannot both win it.
    const requested = input.seatNumber === undefined || input.seatNumber === null ? null : Number(input.seatNumber);
    invariant(requested === null || (Number.isInteger(requested) && requested > 0),
      'INVALID_SEAT', 'Le numéro de siège est invalide.');
    const free = `SELECT seat_number FROM service_seats seats WHERE service_id=$1 AND NOT EXISTS
      (SELECT 1 FROM booking_segments bs WHERE bs.service_id=seats.service_id AND bs.seat_number=seats.seat_number AND bs.sequence >=$2 AND bs.sequence<$3)`;
    const seat = requested === null
      ? await one(tx, free + ' ORDER BY seat_number LIMIT 1', [serviceId, origin, destination])
      : await one(tx, free + ' AND seats.seat_number=$4', [serviceId, origin, destination, requested]);
    // Refusing by name matters: "complet" and "ce siège vient d’être pris" are
    // different problems, and a passenger can act on the second one.
    invariant(seat, requested === null ? 'SOLD_OUT' : 'SEAT_TAKEN',
      requested === null ? 'No seat is available on every requested segment.'
        : 'Ce siège vient d’être pris. Choisissez-en un autre.', 409);
    const pricing=priceWithServiceFee(quote.fare.amountMinor);
    const booking = await one(tx, `INSERT INTO bookings(service_id,passenger_id,origin_sequence,destination_sequence,seat_number,status,amount_minor,service_fee_minor,expires_at,idempotency_key,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,'held',$6,$7,now()+interval '10 minutes',$8,$9) RETURNING *`,
    [serviceId, actor.id, origin, destination, seat.seat_number, quote.fare.amountMinor,pricing.serviceFeeMinor, key, hash]);
    await tx.query('INSERT INTO booking_passengers(booking_id,passenger_id) VALUES($1,$2)', [booking.id, actor.id]);
    await tx.query(`INSERT INTO booking_segments(booking_id,service_id,seat_number,sequence)
      SELECT $1,$2,$3,generate_series($4::integer,$5::integer-1)`, [booking.id, serviceId, seat.seat_number, origin, destination]);
    await tx.query('UPDATE users SET last_meaningful_activity_at=now() WHERE id=$1', [actor.id]);
    await emit(tx, 'booking.held', booking.id, { serviceId });
    return booking;
  }

  /** A purchase with its seats. The seats are the bookings; this is the order. */
  async function groupWithMembers(tx, group) {
    const bookings = (await tx.query(
      'SELECT * FROM bookings WHERE group_id=$1 ORDER BY seat_number', [group.id])).rows;
    return { ...group, quantity: group.quantity, perPassengerMinor: group.seat_amount_minor, bookings };
  }

  /**
   * What a payment route's :id refers to — one seat, or a whole purchase.
   *
   * Payment-shaped routes accept either, because paying for a party and paying
   * for one seat are the same act against a different target. The booking-shaped
   * routes (confirm, cancel, board, alight, ticket) deliberately do NOT: those
   * are per-traveller operations with different meanings for a group, and quietly
   * reinterpreting one would be worse than refusing it.
   *
   * Both identifiers are primary keys drawn from the same generator, so they
   * cannot collide and the lookup is unambiguous.
   */
  async function payableTarget(tx, actor, id) {
    const group = await one(tx, 'SELECT * FROM booking_groups WHERE id=$1', [uuid(id)]);
    if (group) {
      const service = await serviceLock(tx, group.service_id);
      // The same two principals who can read a booking: the person who bought it,
      // or the crew and operations staff of the service it is on. The second one
      // is not a technicality — a counter clerk settling a party in cash is
      // exactly that, and the counter is where most of these are paid for.
      if (actor?.role === 'passenger') invariant(actor.id === group.purchaser_id, 'FORBIDDEN', 'This purchase is not yours.', 403);
      else await crew(tx, actor, service);
      // Locked up front, so nothing can change between validating the party and
      // confirming it.
      const bookings = (await tx.query('SELECT * FROM bookings WHERE group_id=$1 ORDER BY seat_number FOR UPDATE', [group.id])).rows;
      return { kind: 'group', id: group.id, group, service, amount_minor: group.amount_minor,
        service_fee_minor:group.service_fee_minor??0,bookings };
    }
    const { booking, service } = await getBooking(tx, id, actor);
    // A seat bought as part of a party is paid for by the party. Letting it take
    // a payment of its own as well is a second charge for a seat that is already
    // covered, and the operator would be credited for both.
    invariant(!booking.group_id, 'PAYMENT_TARGET_GROUPED',
      'Ce billet fait partie d’un achat groupé : le règlement se fait sur l’achat entier.', 409);
    return { kind: 'booking', id: booking.id, booking, service, amount_minor: booking.amount_minor,
      service_fee_minor:booking.service_fee_minor??0,bookings: [booking] };
  }


  /**
   * One request, N seats, one payment.
   *
   * Quantity 1 is not a special case bolted on: it is this function with N = 1,
   * and it produces a purchase holding a single booking whose own fare equals
   * the purchase total — the same numbers, the same confirmation and the same
   * ticket as a single-seat checkout has always produced. That is what makes the
   * grouped path trustworthy: every purchase exercises it.
   */
  async function txHoldGroup(tx, actor, input, key) {
    invariant(actor?.role === 'passenger', 'FORBIDDEN', 'Passenger access required.', 403);
    const { serviceId, origin, destination } = input;
    idempotencyKey(key);
    const quantity = input.quantity === undefined || input.quantity === null ? 1 : input.quantity;
    invariant(Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_GROUP_QUANTITY,
      'INVALID_QUANTITY', `Choisissez entre 1 et ${MAX_GROUP_QUANTITY} billets.`);
    const requestedSeats = input.seatNumbers ?? (input.seatNumber === undefined || input.seatNumber === null ? null : [Number(input.seatNumber)]);
    invariant(requestedSeats === null || (Array.isArray(requestedSeats) && requestedSeats.length === quantity &&
      requestedSeats.every(n => Number.isInteger(n) && n > 0) && new Set(requestedSeats).size === quantity),
    'INVALID_SEAT', 'Choisissez un siège différent pour chaque billet.');
    const hash = fingerprint([serviceId, origin, destination, quantity]);
    // The idempotency lock is taken BEFORE the service lock, in the same order as
    // the single-seat hold. Two requests that take them in opposite orders
    // deadlock, and the retry path only absorbs deadlocks, not lock timeouts.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.id + ':' + key]);
    const service = await serviceLock(tx, serviceId);
    // The purchase row is the idempotency anchor: one request writes N bookings,
    // so the booking table's own (passenger, key) uniqueness cannot carry it.
    const prior = await one(tx, 'SELECT * FROM booking_groups WHERE purchaser_id=$1 AND idempotency_key=$2', [actor.id, key]);
    if (prior) {
      invariant(prior.request_fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'The key was used for a different request.', 409);
      return groupWithMembers(tx, prior);
    }
    invariant(['scheduled', 'active'].includes(service.status) && origin >= service.current_sequence,
      'SERVICE_UNAVAILABLE', 'This journey is no longer open.', 409);
    invariant(service.status === 'active' || new Date(service.departure_at).getTime() > Date.now(),
      'SERVICE_UNAVAILABLE', 'Departure has passed.', 409);
    // One availability read for the whole purchase, not one per seat: it is five
    // queries, and the service row is held for the length of this transaction.
    const quote = await availability(tx, service, origin, destination);
    // Refusing by the real number matters: "il reste 2 places" is a problem the
    // customer can act on, and "complet" is a different one.
    invariant(quote.available >= quantity, 'SOLD_OUT',
      quote.available === 0 ? 'Plus aucune place sur ce trajet.'
        : `Il ne reste que ${quote.available} place${quote.available > 1 ? 's' : ''} sur ce trajet.`, 409);
    const total = quote.fare.amountMinor * quantity;
    // What the customer was shown is not the price — the server's is. A stale
    // quote is a refusal here rather than a hold at a price nobody agreed to.
    if (input.expectedAmountMinor !== undefined && input.expectedAmountMinor !== null) {
      invariant(Number.isInteger(input.expectedAmountMinor) && input.expectedAmountMinor === total,
        'FARE_CHANGED', 'Le tarif a changé depuis votre recherche. Vérifiez le nouveau prix avant de payer.', 409);
    }
    const free = `SELECT seat_number FROM service_seats seats WHERE service_id=$1 AND NOT EXISTS
      (SELECT 1 FROM booking_segments bs WHERE bs.service_id=seats.service_id AND bs.seat_number=seats.seat_number AND bs.sequence >=$2 AND bs.sequence<$3)`;
    let seats;
    if (requestedSeats === null) {
      const picked = await tx.query(`${free} ORDER BY seat_number LIMIT $4`, [serviceId, origin, destination, quantity]);
      invariant(picked.rows.length === quantity, 'SOLD_OUT', 'No seat is available on every requested segment.', 409);
      seats = picked.rows;
    } else {
      const picked = await tx.query(`${free} AND seats.seat_number = ANY($4::integer[]) ORDER BY seat_number`,
        [serviceId, origin, destination, requestedSeats]);
      invariant(picked.rows.length === quantity, 'SEAT_TAKEN',
        'Un des sièges choisis vient d’être pris. Choisissez-en d’autres.', 409);
      seats = picked.rows;
    }
    const groupPricing=priceWithServiceFee(total);
    const group = await one(tx, `INSERT INTO booking_groups(service_id,origin_sequence,destination_sequence,quantity,
      seat_amount_minor,amount_minor,service_fee_minor,status,purchaser_id,expires_at,idempotency_key,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7,'held',$8,now()+interval '10 minutes',$9,$10) RETURNING *`,
    [serviceId, origin, destination, quantity, quote.fare.amountMinor, total, groupPricing.serviceFeeMinor, actor.id, key, hash]);
    for (const { seat_number: seatNumber } of seats) {
      const booking = await one(tx, `INSERT INTO bookings(service_id,passenger_id,origin_sequence,destination_sequence,seat_number,status,amount_minor,expires_at,idempotency_key,request_fingerprint,group_id)
        VALUES($1,$2,$3,$4,$5,'held',$6,$7,$8,$9,$10) RETURNING *`,
      [serviceId, actor.id, origin, destination, seatNumber, quote.fare.amountMinor, group.expires_at,
        memberKey(group.id, seatNumber), hash, group.id]);
      await tx.query('INSERT INTO booking_passengers(booking_id,passenger_id) VALUES($1,$2)', [booking.id, actor.id]);
      await tx.query(`INSERT INTO booking_segments(booking_id,service_id,seat_number,sequence)
        SELECT $1,$2,$3,generate_series($4::integer,$5::integer-1)`, [booking.id, serviceId, seatNumber, origin, destination]);
    }
    await tx.query('UPDATE users SET last_meaningful_activity_at=now() WHERE id=$1', [actor.id]);
    await emit(tx, 'booking.held', group.id, { serviceId, quantity, groupId: group.id });
    return groupWithMembers(tx, group);
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
      const money = await bookingMoney(tx, b);
      invariant(money.settled, 'PAYMENT_REQUIRED', 'A verified payment record is required.', 409);
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
    /**
     * Bookable departures, with live segment availability.
     *
     * This lives in the domain rather than in a route handler because it is not
     * a transport concern: the PWA, USSD and anything after them must see the
     * same departures, the same fares and the same remaining seats. A second
     * copy of this query is a second answer to "is there a seat?".
     *
     * @param {{originStopId?: string|null, destinationStopId?: string|null, limit?: number, includeDemo?: boolean}} query
     */
    async search({ originStopId = null, destinationStopId = null, limit = 50, includeDemo = false } = {}) {
      invariant(!originStopId === !destinationStopId, 'INVALID_JOURNEY', 'Both origin and destination are required.');
      if (originStopId) { uuid(originStopId); uuid(destinationStopId); }
      // This is the anonymous public catalogue, and it answers the same
      // question as /journey-plan, so it applies the same two rules:
      //
      //  - Only VERIFIED operators are offered. An operator suspended or
      //    rejected after its services were scheduled must stop being
      //    bookable on the decision, not when its last departure expires.
      //  - An INDEPENDENT owner-driver IS the operator, so a passenger
      //    boarding a private vehicle sees the person and the car. A COMPANY
      //    driver is an employee; publishing which named employee drives
      //    which bus at which hour, to anonymous visitors, is staff
      //    surveillance and is not needed to book a seat.
      const rows = await db.transaction(async tx => (await tx.query(`SELECT s.*,r.name AS route_name,o.name AS operator_name,
        o.type AS operator_type,o.verification_status AS operator_verification_status,v.registration,
        o.rating_total,o.rating_count,v.amenities,
        v.make AS vehicle_make,v.model AS vehicle_model,v.color AS vehicle_color,v.model_year AS vehicle_year,
        CASE WHEN o.type='independent' THEN v.photo_url END AS vehicle_photo_url,
        bdp.name AS departure_point_name,bdp.description AS departure_point_landmark,bdp.latitude AS departure_point_latitude,bdp.longitude AS departure_point_longitude,
        bap.name AS arrival_point_name,bap.description AS arrival_point_landmark,bap.latitude AS arrival_point_latitude,bap.longitude AS arrival_point_longitude,
        CASE WHEN o.type='independent' THEN u.display_name END AS driver_name,
        CASE WHEN o.type='independent' THEN dp.photo_url END AS driver_photo_url,
        (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$1) AS origin,
        (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$2) AS destination
        FROM services s JOIN routes r ON r.id=s.route_id JOIN operators o ON o.id=s.operator_id
        JOIN service_assignments a ON a.service_id=s.id AND a.ended_at IS NULL JOIN vehicles v ON v.id=a.vehicle_id
        LEFT JOIN users u ON u.id=a.driver_id LEFT JOIN driver_profiles dp ON dp.user_id=a.driver_id
        LEFT JOIN boarding_points bdp ON bdp.id=s.departure_point_id LEFT JOIN boarding_points bap ON bap.id=s.arrival_point_id
        WHERE s.status IN ('scheduled','active') AND (s.departure_at>now() OR s.status='active') AND (NOT s.is_demo OR $4)
          AND (s.is_demo OR o.verification_status='verified')
        ORDER BY s.departure_at LIMIT $3`, [originStopId, destinationStopId, limit, includeDemo === true])).rows);
      const result = [];
      for (const service of rows) {
        const from = originStopId ? service.origin : service.current_sequence;
        const to = destinationStopId ? service.destination
          : (await db.transaction(async tx => (await tx.query('SELECT max(sequence)::integer AS sequence FROM service_stops WHERE service_id=$1', [service.id])).rows))[0].sequence;
        if (from === null || to === null || from >= to || from < service.current_sequence) continue;
        // The floor is applied here, server-side: a client cannot render a
        // « 5,0 » from one rating because it never receives the average.
        const { rating_total, rating_count, ...offer } = service;
        result.push({ ...offer, rating: publicRating({ rating_total, rating_count }),
          amenities: describeAmenities(service.amenities),
          availability: await this.availability(service.id, from, to) });
      }
      return result;
    },

    async availability(id, origin, destination) {
      return db.transaction(async tx => availability(tx, await serviceLock(tx, id), origin, destination));
    },
    /** The seat map for one span, for a passenger choosing where to sit. */
    async seats(id, origin, destination) {
      return db.transaction(async tx => {
        const service = await serviceLock(tx, uuid(id));
        const stops = (await tx.query('SELECT max(sequence)::integer AS last FROM service_stops WHERE service_id=$1', [service.id])).rows[0];
        const from = Number.isInteger(Number(origin)) ? Number(origin) : 0;
        const to = Number.isInteger(Number(destination)) ? Number(destination) : stops.last;
        invariant(from >= 0 && to > from && to <= stops.last, 'INVALID_JOURNEY', 'Le trajet demandé est invalide.', 409);
        return { serviceId: service.id, origin: from, destination: to, capacity: service.capacity,
          seats: await seatMap(tx, service, from, to) };
      });
    },
    async hold(actor, input, key) {
      return db.transaction(async tx => txHold(tx, actor, input, key));
    },
    /** A purchase of 1..MAX_GROUP_QUANTITY seats, held atomically. */
    async holdGroup(actor, input, key) {
      return db.transaction(async tx => txHoldGroup(tx, actor, input, key));
    },
    /**
     * A purchase by id, for its purchaser or the crew of its service — the same
     * two principals who can read a booking.
     */
    async purchase(actor, id) {
      return db.transaction(async tx => {
        const group = await one(tx, 'SELECT * FROM booking_groups WHERE id=$1', [uuid(id)]);
        invariant(group, 'NOT_FOUND', 'Purchase not found.', 404);
        if (actor?.role === 'passenger') {
          invariant(actor.id === group.purchaser_id, 'FORBIDDEN', 'This purchase is not yours.', 403);
        } else await crew(tx, actor, await serviceLock(tx, group.service_id));
        return groupWithMembers(tx, group);
      });
    },
    // Transaction-level entry points: walk-up sales and other composite
    // flows reuse the exact same domain logic inside their own transaction
    // (no nested connection, no self-deadlock).
    txHold,
    txHoldGroup,
    txTransition,
    payableTarget,
    async booking(actor, id) { return db.transaction(async tx => (await getBooking(tx, id, actor)).booking); },
    /**
     * A booking or a purchase, by id.
     *
     * Both are addressed by the same kind of identifier and a reader who follows
     * one is legitimately asking about either: a ticket bought alone, or a party
     * that was paid for together. Authorization differs between them and is
     * applied by the reader that runs.
     */
    async subject(actor, id) {
      const isPurchase = await db.transaction(async tx =>
        (await tx.query('SELECT 1 FROM booking_groups WHERE id=$1', [uuid(id)])).rows.length > 0);
      return isPurchase ? this.purchase(actor, id) : this.booking(actor, id);
    },
    async passengerBookings(actor) {
      invariant(actor?.role === 'passenger', 'FORBIDDEN', 'Passenger access required.', 403);
      // Expiry is also enforced by the worker and every service operation.
      return db.transaction(async tx => {
        const { rows } = await tx.query('SELECT DISTINCT service_id FROM bookings WHERE passenger_id=$1 ORDER BY service_id', [actor.id]);
        for (const row of rows) await serviceLock(tx, row.service_id);
        return (await tx.query(`SELECT b.*,r.name AS route_name,CASE WHEN b.origin_sequence=0 THEN s.departure_at END AS departure_at,s.departure_point_id,s.arrival_point_id,
          bdp.name AS departure_point_name,bdp.description AS departure_point_landmark,bdp.latitude AS departure_point_latitude,bdp.longitude AS departure_point_longitude,
          bap.name AS arrival_point_name,bap.description AS arrival_point_landmark,bap.latitude AS arrival_point_latitude,bap.longitude AS arrival_point_longitude,
          coalesce(op.name,(SELECT p.name FROM service_stops ss JOIN stops st ON st.id=ss.stop_id JOIN places p ON p.id=st.place_id WHERE ss.service_id=s.id AND ss.sequence=b.origin_sequence)) AS departure_city,
          coalesce(ap.name,(SELECT p.name FROM service_stops ss JOIN stops st ON st.id=ss.stop_id JOIN places p ON p.id=st.place_id WHERE ss.service_id=s.id AND ss.sequence=b.destination_sequence)) AS arrival_city
          FROM bookings b JOIN services s ON s.id=b.service_id JOIN routes r ON r.id=s.route_id
          LEFT JOIN boarding_points bdp ON bdp.id=s.departure_point_id AND bdp.place_id=(SELECT st.place_id FROM service_stops ss JOIN stops st ON st.id=ss.stop_id WHERE ss.service_id=s.id AND ss.sequence=b.origin_sequence) LEFT JOIN places op ON op.id=bdp.place_id
          LEFT JOIN boarding_points bap ON bap.id=s.arrival_point_id AND bap.place_id=(SELECT st.place_id FROM service_stops ss JOIN stops st ON st.id=ss.stop_id WHERE ss.service_id=s.id AND ss.sequence=b.destination_sequence) LEFT JOIN places ap ON ap.id=bap.place_id
          WHERE passenger_id=$1 ORDER BY b.created_at DESC LIMIT 100`, [actor.id])).rows;
      });
    },
    async transition(actor, id, action, stopSequence = undefined) {
      return db.transaction(async tx => txTransition(tx, actor, id, action, stopSequence));
    },
    // Simulated payment for TEST bookings only. Strictly tied to the service's
    // structural test flag: no real provider is ever contacted, no settlement
    // credit is created and no fare-intelligence observation is recorded. The
    // payment row satisfies the booking confirmation flow (paid amount check)
    // so the full booking lifecycle is exercised without touching FedaPay.
    async simulatedTestPayment(actor, id, key, { allowTestInventory = false } = {}) {
      idempotencyKey(key);
      return db.transaction(async tx => {
        const identity = await one(tx, 'SELECT is_demo FROM users WHERE id=$1 AND active', [actor?.id]);
        invariant(identity && (identity.is_demo === true || allowTestInventory), 'FORBIDDEN', 'Test authorization required.', 403);
        const storedKey = 'test-payment:' + actor.id + ':' + key;
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [storedKey]);
        const target = await payableTarget(tx, actor, id);
        const service = target.service;
        invariant(service.is_demo === true, 'FORBIDDEN', 'Simulated payment is only available on TEST services.', 403);
        const prior = await one(tx, 'SELECT * FROM payments WHERE idempotency_key=$1', [storedKey]);
        if (prior) {
          const same = target.kind === 'group' ? prior.group_id === target.id : prior.booking_id === target.id;
          invariant(same, 'IDEMPOTENCY_CONFLICT', 'Key belongs to another booking.', 409);
          return prior;
        }
        invariant(holdsOpen(service, target.bookings), 'INVALID_PAYMENT', 'An active hold is required.', 409);
        invariant(!await one(tx, "SELECT id FROM payments WHERE (booking_id=$1 OR group_id=$1) AND status IN ('pending','succeeded')", [target.id]),
          'PAYMENT_EXISTS', 'Payment already exists.', 409);
        const pricing={fareMinor:target.amount_minor,serviceFeeMinor:target.service_fee_minor,totalMinor:target.amount_minor+target.service_fee_minor};
        const payment = await one(tx, `INSERT INTO payments(booking_id,group_id,provider,provider_reference,amount_minor,fare_minor,service_fee_minor,currency,status,idempotency_key,request_fingerprint,recorded_by)
          VALUES($1,$2,'demo',$3,$4,$5,$6,'XOF','succeeded',$7,$8,$9) RETURNING *`,
        [target.kind === 'booking' ? target.id : null, target.kind === 'group' ? target.id : null,
          'TEST-SIM-' + target.id, pricing.totalMinor, pricing.fareMinor, pricing.serviceFeeMinor, storedKey, fingerprint([target.id, 'test']), actor.id]);
        // Every traveller, in this transaction. A purchase that confirms for some
        // of its party and not others is the half-state this design refuses.
        for (const booking of target.bookings) await txTransition(tx, actor, booking.id, 'confirm');
        await emit(tx, 'payment.recorded', payment.id, {
          ...(target.kind === 'booking' ? { bookingId: target.id } : { groupId: target.id }),
          serviceId: service.id, test: true });
        return payment;
      });
    },
    async recordPayment(actor, id, input, key) {
      idempotencyKey(key);
      invariant(Number.isInteger(input.amountMinor) && input.amountMinor >= 0 && input.currency === 'XOF' &&
        ['cash','bank_transfer','demo'].includes(input.provider) && typeof input.reference === 'string' && input.reference.length <= 100 && input.reference.length > 0,
      'INVALID_PAYMENT', 'Payment record is invalid.');
      const hash = fingerprint([id,input.amountMinor,input.currency,input.provider,input.reference]);
      return db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['payment:' + key]);
        // Taken either way, because a purchase is settled as a whole: a counter
        // clerk handed a party's reference records one cash payment against the
        // purchase, exactly as the online path does. Asking one seat to be paid
        // for on its own is refused by payableTarget and says where to go.
        const target = await payableTarget(tx, actor, id);
        const service = target.service;
        ops(actor, service);
        invariant(input.provider !== 'demo' || service.is_demo, 'INVALID_PAYMENT', 'Demo payment is only allowed on demo services.');
        const prior = await one(tx, 'SELECT * FROM payments WHERE idempotency_key=$1', [key]);
        if (prior) { invariant(prior.request_fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'The key was used for another payment.', 409); return prior; }
        const pricing={fareMinor:target.amount_minor,serviceFeeMinor:target.service_fee_minor,totalMinor:target.amount_minor+target.service_fee_minor};
        invariant(holdsOpen(service, target.bookings) && pricing.totalMinor === input.amountMinor,
          'INVALID_PAYMENT', 'Payment does not match an active hold.', 409);
        invariant(!await one(tx,"SELECT id FROM payments WHERE (booking_id=$1 OR group_id=$1) AND status='pending'",[id]),'PAYMENT_PENDING','Reconcile the pending provider payment before recording another payment.',409);
        invariant(!await one(tx, "SELECT id FROM payments WHERE (booking_id=$1 OR group_id=$1) AND status='succeeded'", [id]), 'ALREADY_PAID', 'Payment already recorded.', 409);
        const payment = await one(tx, `INSERT INTO payments(booking_id,group_id,provider,provider_reference,amount_minor,fare_minor,service_fee_minor,currency,status,idempotency_key,request_fingerprint,recorded_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,'XOF','succeeded',$8,$9,$10) RETURNING *`,
        [target.kind === 'booking' ? target.id : null, target.kind === 'group' ? target.id : null,
          input.provider, input.reference, input.amountMinor, pricing.fareMinor, pricing.serviceFeeMinor, key, hash, actor.id]);
        await emit(tx, 'payment.recorded', payment.id, {
          ...(target.kind === 'booking' ? { bookingId: target.id } : { groupId: target.id }) });
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
      invariant(actor?.role==='driver' || actor?.role==='ops','FORBIDDEN','Driver or operations access required.',403);
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
        // The purchase arm is defence, not the mechanism: a purchase and its
        // seats are written in one transaction, so a purchase whose seats were
        // swept without it should not be possible. Sweeping by it anyway costs
        // one union and removes a way for capacity to look held for ever.
        const { rows } = await tx.query(`SELECT DISTINCT service_id FROM (
          SELECT service_id FROM bookings WHERE status='held' AND expires_at<=now()
          UNION SELECT service_id FROM booking_groups WHERE status='held' AND expires_at<=now()
        ) AS expired_services ORDER BY service_id`);
        for (const row of rows) await serviceLock(tx, row.service_id);
        return { servicesProcessed:rows.length };
      });
    },
    async authorizeService(tx, actor, serviceId, opsOnly = false) {
      const service = await serviceLock(tx, serviceId);
      if (opsOnly) ops(actor, service); else await crew(tx, actor, service);
      return service;
    },
    // Ops reschedules a service or corrects its boarding point. Both change
    // what every passenger was told, so each emits its own event: downstream
    // the timeline is recomputed and the previous timing advice is superseded
    // rather than left to contradict the new one.
    async reschedule(actor, serviceId, input) {
      invariant(input && Object.keys(input).every(k => ['departureAt', 'arrivalAt', 'departurePointId', 'arrivalPointId', 'reason'].includes(k)),
        'INVALID_SCHEDULE', 'Unexpected schedule fields.');
      invariant(input.reason === undefined || input.reason === null || (typeof input.reason === 'string' && input.reason.length <= 200),
        'INVALID_SCHEDULE', 'Reason is too long.');
      for (const key of ['departurePointId', 'arrivalPointId']) if (input[key]) uuid(input[key]);
      const departure = input.departureAt === undefined ? undefined : Date.parse(input.departureAt);
      const arrival = input.arrivalAt === undefined || input.arrivalAt === null ? input.arrivalAt : Date.parse(input.arrivalAt);
      invariant(departure === undefined || Number.isFinite(departure), 'INVALID_SCHEDULE', 'Departure time is invalid.');
      invariant(arrival === undefined || arrival === null || Number.isFinite(arrival), 'INVALID_SCHEDULE', 'Arrival time is invalid.');
      return db.transaction(async tx => {
        const service = await serviceLock(tx, serviceId);
        ops(actor, service);
        invariant(['scheduled', 'active', 'disrupted'].includes(service.status), 'INVALID_TRANSITION', 'This service can no longer be rescheduled.', 409);
        const departureAt = departure === undefined ? service.departure_at : new Date(departure);
        const arrivalAt = arrival === undefined ? service.arrival_at : (arrival === null ? null : new Date(arrival));
        invariant(arrivalAt === null || new Date(arrivalAt) > new Date(departureAt), 'INVALID_SCHEDULE', 'Arrival must follow departure.');
        for (const key of ['departurePointId', 'arrivalPointId']) {
          if (!input[key]) continue;
          invariant(await one(tx, "SELECT id FROM boarding_points WHERE id=$1 AND status='verified'", [input[key]]),
            'INVALID_POINT', 'Only a verified location can be used.', 409);
        }
        const previousPoint = service.departure_point_id;
        const result = await one(tx, `UPDATE services SET departure_at=$2,arrival_at=$3,
          departure_point_id=coalesce($4,departure_point_id),arrival_point_id=coalesce($5,arrival_point_id),updated_at=now()
          WHERE id=$1 RETURNING *`, [service.id, departureAt, arrivalAt, input.departurePointId ?? null, input.arrivalPointId ?? null]);
        const movedTime = new Date(result.departure_at).getTime() !== new Date(service.departure_at).getTime();
        const movedPoint = input.departurePointId && input.departurePointId !== previousPoint;
        if (movedTime) {
          await emit(tx, 'service.rescheduled', service.id, { serviceId: service.id,
            departureAt: new Date(result.departure_at).toISOString(), previousDepartureAt: new Date(service.departure_at).toISOString(),
            reason: input.reason ?? null });
        }
        if (movedPoint) {
          const named = await one(tx, 'SELECT name FROM boarding_points WHERE id=$1', [result.departure_point_id]);
          const previousNamed = previousPoint ? await one(tx, 'SELECT name FROM boarding_points WHERE id=$1', [previousPoint]) : null;
          await emit(tx, 'service.boarding_point_changed', service.id, { serviceId: service.id,
            boardingPointName: named?.name ?? null, previousBoardingPointName: previousNamed?.name ?? null });
        }
        // Distinct from the emitted 'service.rescheduled' notification event:
        // audit() publishes under its own action name, so they must not collide.
        await audit(tx, actor.id, 'service.schedule_changed', service.id, service.operator_id,
          { movedTime, movedPoint, reason: input.reason ?? null });
        return result;
      });
    },
  };
}

export { DomainError };
