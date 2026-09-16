import { invariant, uuid } from '@leroutier/domain';
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

export function tracking(db, config = {}) {
  const thresholds = config.freshness ?? FRESHNESS;

  /**
   * Full tracking picture for one service, optionally narrowed to a
   * passenger's own journey so the arrival estimate targets where *they* get
   * off rather than the end of the line.
   */
  async function serviceTracking(tx, serviceId, { destinationSequence = null, now = Date.now() } = {}) {
    const service = await one(tx, `SELECT s.id,s.route_id,s.status,s.current_sequence,s.departure_at,s.arrival_at,s.operator_id
      FROM services s WHERE s.id=$1`, [serviceId]);
    invariant(service, 'NOT_FOUND', 'Service not found.', 404);

    const stored = await one(tx, 'SELECT coordinates,distance_m,provider,generated_at FROM route_geometries WHERE route_id=$1', [service.route_id]);
    const coordinates = stored?.coordinates ?? null;
    const hasRoad = isValidLine(coordinates);

    const serviceStops = (await rows(tx, `SELECT ss.sequence, st.name, p.name AS city, st.longitude, st.latitude
      FROM service_stops ss JOIN stops st ON st.id=ss.stop_id JOIN places p ON p.id=st.place_id
      WHERE ss.service_id=$1 ORDER BY ss.sequence`, [serviceId]))
      .map(r => ({ sequence: r.sequence, name: r.name, city: r.city,
        longitude: r.longitude === null ? null : Number(r.longitude),
        latitude: r.latitude === null ? null : Number(r.latitude) }));

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
    });

    return {
      serviceId: service.id,
      serviceStatus: service.status,
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
