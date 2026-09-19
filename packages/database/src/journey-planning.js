// Door-to-destination journey planning over the existing domain: place →
// stop → route → segment → service → booking. Nothing here is a second
// journey engine and nothing is computed by a model.
//
//   current location (coordinates, transient) or a stop
//     → first mile (walking estimate; open routing when configured)
//     → pickup stop on a real LeRoutier service
//     → intercity leg (existing service/fare/availability/ETA)
//     → last mile (when the requested destination differs from the drop-off)
//
// Feasibility: an option is only presented when the passenger can reach the
// pickup stop before departure minus a configurable boarding buffer. The
// passenger's exact coordinates never leave this request and are never
// stored or shown to operators.
//
// Synthetic transport inventory (`is_demo` services, the TEST dataset) is
// excluded from public plans by construction: a caller must explicitly ask
// for it AND hold the authorization checked in the API layer. Ordinary
// anonymous visitors can never see demo/test offers.

import { invariant, uuid } from '@leroutier/domain';

const WALK_MPS = 1.25;          // relaxed urban walking pace
const DETOUR_FACTOR = 1.35;     // straight-line → walked distance
const MAX_FIRST_MILE_M = 20_000; // beyond this, no practical first mile
const MAX_NEARBY_STOP_M = 30_000;
const LIVE_FIX_S = 120;         // a GPS fix younger than this is "live"

const hav = (a, b) => {
  const R = 6_371_000, rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const walkLeg = distanceM => ({ mode: 'walking', distanceM: Math.round(distanceM * DETOUR_FACTOR),
  durationS: Math.round((distanceM * DETOUR_FACTOR) / WALK_MPS), source: 'open_routing_estimate' });

// The database stores GeoJSON coordinate pairs, not a GeoJSON object.
// Normalize and clip once so every client receives the selected leg only.
function normalizeGeometry(value, origin, destination) {
  if (!Array.isArray(value) || value.length < 2 || !value.every(p => Array.isArray(p) && p.length === 2 &&
    Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) return null;
  const nearest = stop => value.reduce((best, p, i) => hav(stop, {longitude:p[0],latitude:p[1]}) <
    hav(stop, {longitude:value[best][0],latitude:value[best][1]}) ? i : best, 0);
  const from = nearest(origin), to = nearest(destination);
  return from < to ? value.slice(from, to + 1) : null;
}

export function journeyPlanning(db, { boardingBufferS = 600, positionFreshSeconds = LIVE_FIX_S } = {}) {
  return {
    /**
     * One coherent plan operation.
     * @param {{ originStopId?: string|null, origin?: {latitude:number,longitude:number}|null,
     *   destinationStopId?: string|null, destination?: {latitude:number,longitude:number}|null,
     *   departureAt?: string|null, includeDemo?: boolean }} input
     */
    async plan(input = {}) {
      invariant(input && typeof input === 'object', 'INVALID_JOURNEY', 'Journey fields are invalid.');
      if (input.originStopId) uuid(input.originStopId);
      else if (input.origin) invariant(
        Number.isFinite(input.origin.latitude) && Number.isFinite(input.origin.longitude) &&
        Math.abs(input.origin.latitude) <= 90 && Math.abs(input.origin.longitude) <= 180,
        'INVALID_JOURNEY', 'Origin coordinates are invalid.');
      else invariant(false, 'INVALID_JOURNEY', 'An origin and a destination are required.', 409);
      if (input.destinationStopId) uuid(input.destinationStopId);
      else if (input.destination) invariant(
        Number.isFinite(input.destination.latitude) && Number.isFinite(input.destination.longitude) &&
        Math.abs(input.destination.latitude) <= 90 && Math.abs(input.destination.longitude) <= 180,
        'INVALID_JOURNEY', 'Destination coordinates are invalid.');
      else invariant(false, 'INVALID_JOURNEY', 'An origin and a destination are required.', 409);
      const departureAt = input.departureAt ? Date.parse(input.departureAt) : Date.now();
      invariant(Number.isFinite(departureAt), 'INVALID_JOURNEY', 'Departure time is invalid.', 409);
      // Demo/test inventory is opt-in; the caller authorizes it (API layer).
      const includeDemo = input.includeDemo === true;
      const now = Date.now();
      const journeyStart = Math.max(now, departureAt);

      const stops = await db.transaction(async tx => (await tx.query(`SELECT s.id,s.name,s.latitude,s.longitude,p.name AS city
        FROM stops s JOIN places p ON p.id=s.place_id WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL`)).rows);

      // Origin resolution: coordinates (the passenger's own position) resolve
      // to practical pickup stops; a stop id resolves to itself plus nearby
      // stops when it is not served.
      const originCoords = input.origin ?? (stops.find(s => s.id === input.originStopId)
        ? { latitude: stops.find(s => s.id === input.originStopId).latitude, longitude: stops.find(s => s.id === input.originStopId).longitude } : null);
      invariant(originCoords, 'INVALID_JOURNEY', 'Origin stop is unknown.', 404);
      const destinationStop = stops.find(s => s.id === input.destinationStopId);
      const destinationCoords = input.destination ?? (destinationStop ? { latitude: destinationStop.latitude, longitude: destinationStop.longitude } : null);
      invariant(destinationCoords, 'INVALID_JOURNEY', 'Destination is unknown.', 404);

      const origins = stops
        .map(s => ({ ...s, distanceM: hav(originCoords, s) }))
        .filter(s => s.distanceM <= (input.origin ? MAX_FIRST_MILE_M : MAX_NEARBY_STOP_M))
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, 3);

      const options = [];
      for (const origin of origins) {
        // The destination may be another stop, or a coordinate whose nearest
        // served stop defines the intercity drop-off and the last mile.
        const destinations = destinationStop ? [destinationStop]
          : stops.map(s => ({ ...s, distanceM: hav(destinationCoords, s) })).sort((a, b) => a.distanceM - b.distanceM).slice(0, 2);
        for (const destination of destinations) {
          if (origin.id === destination.id) continue;
          const services = await db.transaction(async tx => (await tx.query(
            `SELECT s.id,s.operator_id,s.route_id,s.departure_at,s.arrival_at,s.status,s.is_demo,s.capacity,s.current_sequence,
              o.name AS operator_name,o.type AS operator_type,r.name AS route_name,
              v.registration AS vehicle_registration,v.model AS vehicle_model,
              (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$1) AS origin_seq,
              (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$2) AS destination_seq,
              (SELECT coalesce(sum(ss.fare_minor),0)::integer FROM service_segments ss
                WHERE ss.service_id=s.id AND ss.sequence >= (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$1)
                  AND ss.sequence < (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$2)) AS fare_minor,
              (SELECT count(*)::integer FROM service_seats seats WHERE seats.service_id=s.id AND NOT EXISTS
                (SELECT 1 FROM booking_segments bs WHERE bs.service_id=seats.service_id AND bs.seat_number=seats.seat_number
                  AND bs.sequence >= (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$1)
                  AND bs.sequence < (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$2))) AS available,
              (SELECT duration_s FROM route_geometries WHERE route_id=s.route_id LIMIT 1) AS route_duration_s,
              (SELECT json_agg(json_build_object('sequence',g.sequence,'stopId',g.stop_id,'name',st.name,'city',pl.name,'latitude',st.latitude,'longitude',st.longitude) ORDER BY g.sequence)
                FROM service_stops g JOIN stops st ON st.id=g.stop_id JOIN places pl ON pl.id=st.place_id WHERE g.service_id=s.id) AS service_stops,
              (SELECT coordinates FROM route_geometries WHERE route_id=s.route_id LIMIT 1) AS route_geometry,
              (SELECT json_build_object('latitude',vp.latitude,'longitude',vp.longitude,'observedAt',vp.observed_at)
                FROM vehicle_positions vp WHERE vp.service_id=s.id ORDER BY vp.observed_at DESC LIMIT 1) AS live_position
            FROM services s JOIN routes r ON r.id=s.route_id JOIN operators o ON o.id=s.operator_id
            LEFT JOIN service_assignments a ON a.service_id=s.id AND a.ended_at IS NULL
            LEFT JOIN vehicles v ON v.id=a.vehicle_id
            WHERE s.status IN ('scheduled','active') AND (s.departure_at>now() OR s.status='active')
              AND (NOT s.is_demo OR $3)
              AND EXISTS (SELECT 1 FROM service_stops WHERE service_id=s.id AND stop_id=$1)
              AND EXISTS (SELECT 1 FROM service_stops WHERE service_id=s.id AND stop_id=$2)
            ORDER BY s.departure_at LIMIT 20`, [origin.id, destination.id, includeDemo])).rows);
          for (const service of services) {
            if (service.origin_seq === null || service.destination_seq === null || service.origin_seq >= service.destination_seq) continue;
            const firstMile = input.origin || origin.id !== input.originStopId ? walkLeg(origin.distanceM) : null;
            const lastMile = !destinationStop ? walkLeg(destination.distanceM) : null;
            const reachableAt = journeyStart + (firstMile?.durationS ?? 0) * 1000 + boardingBufferS * 1000;
            const feasible = new Date(service.departure_at).getTime() >= reachableAt && service.origin_seq >= service.current_sequence;
            // Waiting at the pickup: the time between arriving and boarding.
            // Part of the full door-to-destination duration, never hidden.
            const waitingS = Math.max(0, Math.round((new Date(service.departure_at).getTime() - journeyStart - (firstMile?.durationS ?? 0) * 1000) / 1000));
            const fullRoute = service.origin_seq === 0 && service.destination_seq === (service.service_stops ?? []).at(-1)?.sequence;
            const intercityS = !fullRoute ? null : service.arrival_at
              ? Math.max(0, (new Date(service.arrival_at).getTime() - new Date(service.departure_at).getTime()) / 1000)
              : service.route_duration_s ?? null;
            const totalDurationS = intercityS === null ? null : (firstMile?.durationS ?? 0) + waitingS + intercityS + (lastMile?.durationS ?? 0);
            const arrival = intercityS === null ? null : new Date(new Date(service.departure_at).getTime() + intercityS * 1000);
            const etaAt = arrival ? new Date(arrival.getTime() + (lastMile?.durationS ?? 0) * 1000) : null;
            const intermediateStops = (service.service_stops ?? []).filter(st => st.sequence >= service.origin_seq && st.sequence <= service.destination_seq);
            // A position is only called "live" when it is genuinely recent;
            // anything older is the last known position, plainly labelled.
            let live = null;
            if (service.live_position) {
              const ageS = Math.floor((now - Date.parse(service.live_position.observedAt)) / 1000);
              live = { ...service.live_position, signal: ageS >= 0 && ageS <= positionFreshSeconds ? 'live' : 'stale', ageSeconds: Math.max(0, ageS) };
            }
            options.push({
              serviceId: service.id, operatorName: service.operator_name, operatorType: service.operator_type,
              routeName: service.route_name, departureAt: service.departure_at, serviceStatus: service.status,
              originSequence: service.origin_seq, destinationSequence: service.destination_seq,
              pickupStop: { id: origin.id, name: origin.name, city: origin.city, latitude: origin.latitude, longitude: origin.longitude },
              dropoffStop: { id: destination.id, name: destination.name, city: destination.city, latitude: destination.latitude, longitude: destination.longitude },
              vehicle: { registration: service.vehicle_registration ?? null, model: service.vehicle_model ?? null },
              intermediateStops,
              routeGeometry: normalizeGeometry(service.route_geometry, origin, destination),
              livePosition: live,
              fare: { amountMinor: service.fare_minor, currency: 'XOF' },
              available: service.available, capacity: service.capacity, feasible,
              firstMile, waitingS, intercity: { durationS: intercityS, etaAt: arrival?.toISOString() ?? null }, lastMile,
              totalDurationS, etaAt: etaAt?.toISOString() ?? null, isTest: service.is_demo === true,
            });
          }
        }
      }
      // Feasible options first; infeasible ones remain visible but never
      // presented as bookable.
      options.sort((a, b) => (Number(b.feasible) - Number(a.feasible)) || ((a.totalDurationS ?? Infinity) - (b.totalDurationS ?? Infinity)));
      return { options: options.slice(0, 10), originResolved: origins[0] ? { id: origins[0].id, name: origins[0].name, city: origins[0].city, distanceM: Math.round(origins[0].distanceM) } : null,
        destinationResolved: destinationStop ?? null, includeDemo, generatedAt: new Date().toISOString() };
    },
  };
}
