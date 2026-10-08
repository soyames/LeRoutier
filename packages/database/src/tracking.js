import { invariant, uuid } from '@leroutier/domain';
import { fingerprint } from './route-geometry.js';
import { isValidLine, routeProgress, projectStops, stopStates, nextStopFrom, offRouteState,
  freshness, estimateArrival, FRESHNESS } from '@leroutier/geo';

// Where the vehicle is, how far the journey has come, and when it should
// arrive — assembled from the stored road geometry and real GPS observations.
//
// Nothing here invents a position, a line or an arrival time. With no geometry
// the answer is stops without a road; with no recent GPS the answer says so.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const rows = async (tx, sql, args = []) => (await tx.query(sql, args)).rows;

// Enough recent fixes to derive movement and judge a sustained deviation.
const OBSERVATION_WINDOW = 6;

const publicPosition = row => (row ? {
  latitude: Number(row.latitude), longitude: Number(row.longitude),
  observedAt: row.observed_at,
  accuracyM: row.accuracy_m === null || row.accuracy_m === undefined ? null : Number(row.accuracy_m),
  // Device speed and heading are operational detail, not passenger content.
} : null);

/**
 * The ticket number a passenger actually holds.
 *
 * "Référence" on a ticket is the first eight characters of the booking's
 * identifier, and the printed document prefixes the same eight with `LRB-`.
 * Both spellings name the same ticket, so both are accepted and folded to one
 * canonical form here — the ONE place that decides what a ticket number is.
 *
 * @param {unknown} value the raw field text, exactly as typed
 * @returns {string|null} eight upper-case hex characters, or null
 */
export function parseTicketReference(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().replace(/\s+/g, '').toUpperCase().match(/^(?:LRB-)?([0-9A-F]{8})$/);
  return match ? match[1] : null;
}

/**
 * The identifier range eight hex characters stand for.
 *
 * The reference is a PREFIX of the booking id, so the lookup is an inclusive
 * range on the primary key rather than a `LIKE` over a cast: the index does the
 * work, and the range is exact (nothing above `FFFFFFFF-…` exists to be missed).
 */
function referenceBounds(reference) {
  const head = `${reference.slice(0, 4)}-${reference.slice(4, 8)}`;
  return { low: `${head}-0000-0000-0000-000000000000`, high: `${head}-ffff-ffff-ffff-ffffffffffff` };
}

export function tracking(db, config = {}) {
  const thresholds = config.freshness ?? FRESHNESS;

  /**
   * Full tracking picture for one service, optionally narrowed to a
   * passenger's own journey so the arrival estimate targets where *they* get
   * off rather than the end of the line.
   */
  async function serviceTracking(tx, serviceId, { destinationSequence = null, now = Date.now() } = {}) {
    const service = await one(tx, `SELECT s.id,s.route_id,s.status,s.current_sequence,s.departure_at,s.arrival_at,s.operator_id,s.is_demo
      FROM services s WHERE s.id=$1`, [serviceId]);
    invariant(service, 'NOT_FOUND', 'Service not found.', 404);

    const stored = await one(tx, 'SELECT coordinates,distance_m,duration_s,provider,generated_at,input_hash,stop_count FROM route_geometries WHERE route_id=$1', [service.route_id]);
    const coordinates = stored?.coordinates ?? null;

    const serviceStops = (await rows(tx, `SELECT ss.sequence, st.name, p.name AS city, st.longitude, st.latitude
      FROM service_stops ss JOIN stops st ON st.id=ss.stop_id JOIN places p ON p.id=st.place_id
      WHERE ss.service_id=$1 ORDER BY ss.sequence`, [serviceId]))
      .map(r => ({ sequence: r.sequence, name: r.name, city: r.city,
        longitude: r.longitude === null ? null : Number(r.longitude),
        latitude: r.latitude === null ? null : Number(r.latitude) }));
    const hasRoad = isValidLine(coordinates) && stored.input_hash===fingerprint(serviceStops) && stored.stop_count===serviceStops.length;

    const observations = (await rows(tx, `SELECT latitude,longitude,observed_at,accuracy_m,speed_mps
      FROM vehicle_positions WHERE service_id=$1 ORDER BY observed_at DESC LIMIT $2`, [serviceId, OBSERVATION_WINDOW]))
      .reverse()
      .map(r => ({ latitude: Number(r.latitude), longitude: Number(r.longitude), observedAt: r.observed_at,
        accuracyM: r.accuracy_m === null ? null : Number(r.accuracy_m),
        speedMps: r.speed_mps === null ? null : Number(r.speed_mps) }));
    const latest = observations.at(-1) ?? null;
    const signal = freshness(latest?.observedAt ?? null, now, thresholds);

    // Progress requires both a road line and a position. Without either, the
    // journey is described by its stops and the operational sequence alone.
    let progress = null, projected = [], states, next, offRoute = { offRoute: false, worstOffRouteM: null, samples: 0 };
    if (hasRoad) {
      projected = projectStops(coordinates, serviceStops);
      if (latest) {
        // Monotonic along the line: replay the window so a noisy fix cannot
        // rewind the passenger's remaining distance.
        let along = null;
        const perSample = [];
        for (const observation of observations) {
          const step = routeProgress(coordinates, [observation.longitude, observation.latitude], { previousAlongM: along });
          if (!step) continue;
          along = step.distanceAlongM;
          perSample.push({ offRouteM: step.offRouteM, accuracyM: observation.accuracyM });
        }
        progress = routeProgress(coordinates, [latest.longitude, latest.latitude], { previousAlongM: along });
        offRoute = offRouteState(perSample);
      }
      const along = progress?.distanceAlongM ?? 0;
      states = stopStates(projected, along, { reachedSequence: service.current_sequence });
      next = nextStopFrom(projected, along, { reachedSequence: service.current_sequence });
    } else {
      // No road geometry: stops are still ordered and the operational sequence
      // still says which have been reached.
      states = serviceStops.map(stop => ({ ...stop,
        state: stop.sequence <= service.current_sequence ? 'passed'
          : stop.sequence === service.current_sequence + 1 ? 'next' : 'upcoming' }));
      next = serviceStops.find(stop => stop.sequence === service.current_sequence + 1) ?? null;
    }

    // Remaining distance to the passenger's own stop where the road is known.
    const target = destinationSequence === null ? null : projected.find(s => s.sequence === destinationSequence) ?? null;
    const remainingM = !hasRoad || !progress ? null
      : target?.distanceAlongM !== undefined && target?.distanceAlongM !== null
        ? Math.max(0, target.distanceAlongM - progress.distanceAlongM)
        : progress.remainingM;

    const eta = estimateArrival({
      remainingM, observations, observedAt: latest?.observedAt ?? null,
      // Only the end of the line has a scheduled time; an intermediate stop
      // has none, so no schedule fallback is offered for it.
      scheduledAt: destinationSequence === null || destinationSequence === serviceStops.at(-1)?.sequence ? service.arrival_at : null,
      now, speedMps: latest?.speedMps ?? null, thresholds,
      routeDistanceM:stored?.distance_m, routeDurationS:stored?.duration_s,
      disrupted:service.status==='disrupted' || offRoute.offRoute,
    });
    const nextTarget = next && projected.find(s => s.sequence === next.sequence);
    const nextRemainingM = !hasRoad || !progress || !nextTarget ? null
      : Math.max(0, nextTarget.distanceAlongM - progress.distanceAlongM);
    const nextEta = next
      ? estimateArrival({
        remainingM: nextRemainingM, observations, observedAt: latest?.observedAt ?? null,
        now, speedMps: latest?.speedMps ?? null, thresholds,
        routeDistanceM: stored?.distance_m, routeDurationS: stored?.duration_s,
        disrupted: service.status === 'disrupted' || offRoute.offRoute,
      })
      : null;

    return {
      serviceId: service.id,
      serviceStatus: service.status,
      // Synthetic TEST GPS feeds are labelled; they are never mixed with or
      // presented as real vehicle tracking data.
      isTest: service.is_demo === true,
      route: hasRoad
        ? { available: true, coordinates, distanceM: stored.distance_m, provider: stored.provider, generatedAt: stored.generated_at }
        // Stated plainly so no surface draws a straight line instead.
        : { available: false, coordinates: null, distanceM: null, provider: null, generatedAt: null },
      position: publicPosition(latest ? { latitude: latest.latitude, longitude: latest.longitude,
        observed_at: latest.observedAt, accuracy_m: latest.accuracyM } : null),
      signal: signal.state,
      signalAgeSeconds: signal.ageSeconds,
      progress: progress && { distanceAlongM: progress.distanceAlongM, remainingM, totalM: progress.totalM, fraction: progress.progress },
      // Stop coordinates travel with the states: the map draws its markers from
      // this same list, and a boarding point's position is already public.
      stops: states.map(s => ({ sequence: s.sequence, name: s.name, city: s.city, state: s.state,
        latitude: s.latitude ?? null, longitude: s.longitude ?? null })),
      nextStop: next ? { sequence: next.sequence, name: next.name, city: next.city } : null,
      nextEta,
      currentSegment: next ? {fromSequence:Math.max(0,next.sequence-1),toSequence:next.sequence} : null,
      // Deviation is an operational signal; it is not surfaced to passengers.
      offRoute: offRoute.offRoute,
      offRouteM: offRoute.worstOffRouteM,
      eta,
    };
  }

  return {
    serviceTracking,

    /**
     * Tracking for a passenger's own booking: scoped to their booking and
     * targeted at their alighting stop.
     */
    async forBooking(actor, bookingId, { now = Date.now() } = {}) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      uuid(bookingId);
      return db.transaction(async tx => {
        const booking = await one(tx, `SELECT id,service_id,status,origin_sequence,destination_sequence
          FROM bookings WHERE id=$1 AND passenger_id=$2`, [bookingId, actor.id]);
        invariant(booking, 'NOT_FOUND', 'Booking not found.', 404);
        // Live vehicle tracking belongs to a journey actually being taken.
        invariant(['confirmed', 'boarded', 'completed'].includes(booking.status),
          'FORBIDDEN', 'An active ticket is required.', 403);
        const result = await serviceTracking(tx, booking.service_id, { destinationSequence: booking.destination_sequence, now });
        return { ...result, bookingId: booking.id, boardingSequence: booking.origin_sequence, destinationSequence: booking.destination_sequence };
      });
    },

    /**
     * Tracking for somebody holding a ticket number and nothing else.
     *
     * A passenger who bought without an account has a reference and no login,
     * and reading their own journey's progress must not require either. Holding
     * the ticket number is what the counter accepts for the same journey, so it
     * is what this accepts — and it is the WHOLE of what it accepts.
     *
     * WHAT COMES BACK, and what never does. The answer is the same operational
     * picture a signed-in passenger sees, built by the same `serviceTracking`,
     * plus the route facts printed on the ticket. It is assembled field by
     * field from a whitelist: no name, no phone, no seat, no payments, no
     * account, no other traveller on board, and no device speed or heading.
     * Nothing here is derived from who is asking, because nothing knows.
     *
     * THE TICKET NUMBER IS GUESSABLE, and that is handled by the caller, not
     * here: this function is only ever reached through a route that meters each
     * client address. Eight hex characters is four billion possibilities, which
     * is not a secret — the rate limit is what makes enumeration hopeless, and
     * it has to hold on every deployment rather than in this module.
     *
     * @param {string} reference the eight-hex ticket reference, or `LRB-` + it
     * @param {{ now?: number }} [options]
     */
    async publicTicketTracking(reference, { now = Date.now() } = {}) {
      const ticket = parseTicketReference(reference);
      // A malformed number is answered as its own case rather than as "not
      // found": "that is not a ticket number" and "no such ticket" are
      // different things to say to somebody who mistyped one character.
      invariant(ticket, 'INVALID_REFERENCE', 'Ce numéro de billet n’est pas valide.', 400);
      const { low, high } = referenceBounds(ticket);
      return db.transaction(async tx => {
        // A reference is eight characters of a random identifier, so a collision
        // is possible in principle and the reader has to resolve one anyway. A
        // journey in progress leads, then the next departure, then the most
        // recent one: that is the order somebody opening this screen is asking
        // in. Anything held, expired or abandoned is not a ticket and is not
        // offered.
        const candidates = await rows(tx, `SELECT b.id,b.status,b.origin_sequence,b.destination_sequence,b.service_id,
          s.departure_at,s.arrival_at,s.status AS service_status,s.is_demo,
          r.name AS route_name,o.name AS operator_name,
          coalesce(op.name,(SELECT p.name FROM service_stops ss JOIN stops st ON st.id=ss.stop_id
            JOIN places p ON p.id=st.place_id WHERE ss.service_id=s.id AND ss.sequence=b.origin_sequence)) AS departure_city,
          coalesce(ap.name,(SELECT p.name FROM service_stops ss JOIN stops st ON st.id=ss.stop_id
            JOIN places p ON p.id=st.place_id WHERE ss.service_id=s.id AND ss.sequence=b.destination_sequence)) AS arrival_city
          FROM bookings b
          JOIN services s ON s.id=b.service_id
          JOIN routes r ON r.id=s.route_id
          JOIN operators o ON o.id=s.operator_id
          LEFT JOIN boarding_points bdp ON bdp.id=s.departure_point_id AND bdp.place_id=(SELECT st.place_id
            FROM service_stops ss JOIN stops st ON st.id=ss.stop_id WHERE ss.service_id=s.id AND ss.sequence=b.origin_sequence)
          LEFT JOIN places op ON op.id=bdp.place_id
          LEFT JOIN boarding_points bap ON bap.id=s.arrival_point_id AND bap.place_id=(SELECT st.place_id
            FROM service_stops ss JOIN stops st ON st.id=ss.stop_id WHERE ss.service_id=s.id AND ss.sequence=b.destination_sequence)
          LEFT JOIN places ap ON ap.id=bap.place_id
          WHERE b.id BETWEEN $1::uuid AND $2::uuid
            AND b.status IN ('confirmed','boarded','completed','cancelled')`, [low, high]);
        invariant(candidates.length, 'NOT_FOUND', 'Aucun billet ne correspond à ce numéro.', 404);
        // Boarded first, then the next departure, then the most recent one.
        const rank = row => row.status === 'boarded' ? 0 : row.status === 'confirmed' ? 1
          : row.status === 'completed' ? 2 : 3;
        const booking = candidates.sort((a, b) =>
          rank(a) - rank(b) || new Date(b.departure_at).getTime() - new Date(a.departure_at).getTime())[0];
        // A cancelled ticket has no journey left to describe, and saying so is
        // the honest answer rather than a progress bar on a service that will
        // not run.
        const tracking = booking.status === 'cancelled' || booking.service_status === 'cancelled'
          ? null
          : await serviceTracking(tx, booking.service_id, { destinationSequence: booking.destination_sequence, now });
        return {
          reference: ticket,
          ticket: {
            status: booking.status,
            serviceStatus: booking.service_status,
            routeName: booking.route_name,
            operatorName: booking.operator_name,
            departureCity: booking.departure_city,
            arrivalCity: booking.arrival_city,
            departureAt: booking.departure_at,
            arrivalAt: booking.arrival_at,
            boardingSequence: booking.origin_sequence,
            destinationSequence: booking.destination_sequence,
            // Synthetic inventory is labelled here exactly as it is everywhere
            // else, so a demonstration never reads as a real departure.
            isTest: booking.is_demo === true,
          },
          // The whole picture, or the honest absence of one. Never a substitute.
          tracking: tracking && {
            serviceStatus: tracking.serviceStatus,
            isTest: tracking.isTest,
            route: tracking.route,
            position: tracking.position,
            signal: tracking.signal,
            signalAgeSeconds: tracking.signalAgeSeconds,
            progress: tracking.progress,
            stops: tracking.stops,
            nextStop: tracking.nextStop,
            nextEta: tracking.nextEta,
            eta: tracking.eta,
            boardingSequence: tracking.boardingSequence ?? booking.origin_sequence,
            destinationSequence: tracking.destinationSequence ?? booking.destination_sequence,
          },
        };
      });
    },

    /** Tracking for crew and operations, authorised through the service. */
    async forService(actor, serviceId, authorizeService, { now = Date.now() } = {}) {
      uuid(serviceId);
      return db.transaction(async tx => {
        await authorizeService(tx, actor, serviceId);
        return serviceTracking(tx, serviceId, { now });
      });
    },

    /**
     * Active services of one operator, for the Ops fleet view.
     * Scoped to the caller's operator: a company never sees another's fleet.
     */
    async fleet(actor, { now = Date.now() } = {}) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      return db.transaction(async tx => {
        const services = await rows(tx, `SELECT s.id FROM services s
          WHERE s.status IN ('active','disrupted') AND ($1::uuid IS NULL OR s.operator_id=$1)
          ORDER BY s.departure_at LIMIT 50`, [actor.operator_id ?? null]);
        const result = [];
        for (const service of services) result.push(await serviceTracking(tx, service.id, { now }));
        return result;
      });
    },
  };
}
