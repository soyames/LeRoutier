import { invariant, uuid, journeyPlan, FIRST_MILE_POLICY } from '@leroutier/domain';
import { directionsUrl } from './mobility.js';

// The passenger journey is wider than the intercity leg: home -> first mile ->
// exact boarding point -> intercity service -> arrival point -> last mile.
// Every milestone below is derived from real booking/service/boarding-point
// state; nothing operational is invented. Times LeRoutier computes rather than
// observes are marked estimated so the UI can label them honestly.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];

const point = (r, prefix) => (r?.[prefix + '_name'] ? {
  name: r[prefix + '_name'], city: r[prefix + '_city'] ?? null, landmark: r[prefix + '_landmark'] ?? null,
  latitude: r[prefix + '_latitude'] ?? null, longitude: r[prefix + '_longitude'] ?? null,
  directionsUrl: directionsUrl({ latitude: r[prefix + '_latitude'], longitude: r[prefix + '_longitude'] }),
} : null);

export function journeys(db, config = {}) {
  const policy = config.firstMile ?? FIRST_MILE_POLICY;
  return {
    // Timeline for one of the caller's own bookings. Passenger-scoped: a crew
    // member or operator never reads a passenger's journey through this route.
    async timeline(actor, bookingId, { localTravelMinutes = null } = {}) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      uuid(bookingId);
      invariant(localTravelMinutes === null || (Number.isInteger(localTravelMinutes) && localTravelMinutes >= 0 && localTravelMinutes <= 600),
        'INVALID_TRAVEL_ESTIMATE', 'Local travel estimate is invalid.');
      return db.transaction(async tx => {
        const row = await one(tx, `SELECT b.id,b.status,b.created_at,b.origin_sequence,b.destination_sequence,
          s.id AS service_id,s.departure_at,s.arrival_at,s.status AS service_status,s.current_sequence,
          o.country AS operator_country,o.name AS operator_name,
          bdp.name AS departure_name,bdp.description AS departure_landmark,bdp.latitude AS departure_latitude,
          bdp.longitude AS departure_longitude,dp.name AS departure_city,
          bap.name AS arrival_name,bap.description AS arrival_landmark,bap.latitude AS arrival_latitude,
          bap.longitude AS arrival_longitude,ap.name AS arrival_city,
          (SELECT count(*)::integer FROM ticket_credentials t WHERE t.booking_id=b.id) AS ticket_issued,
          (SELECT coalesce(sum(amount_minor),0)::integer FROM payments p WHERE p.booking_id=b.id AND p.status='succeeded') AS paid_minor,
          b.amount_minor
          FROM bookings b JOIN services s ON s.id=b.service_id JOIN operators o ON o.id=s.operator_id
          LEFT JOIN boarding_points bdp ON bdp.id=s.departure_point_id LEFT JOIN places dp ON dp.id=bdp.place_id
          LEFT JOIN boarding_points bap ON bap.id=s.arrival_point_id LEFT JOIN places ap ON ap.id=bap.place_id
          WHERE b.id=$1 AND b.passenger_id=$2`, [bookingId, actor.id]);
        invariant(row, 'NOT_FOUND', 'Booking not found.', 404);

        const plan = journeyPlan({ departureAt: row.departure_at, arrivalAt: row.arrival_at, localTravelMinutes, policy });
        const departurePoint = point(row, 'departure'), arrivalPoint = point(row, 'arrival');
        const providers = (await tx.query(
          `SELECT * FROM mobility_providers WHERE active AND country=$1 AND capabilities @> '["first_mile"]'::jsonb ORDER BY name`,
          [row.operator_country ?? 'BJ'])).rows;
        const suggestion = providers[0] ?? null;
        const paid = row.paid_minor >= row.amount_minor;
        const cancelled = ['cancelled', 'expired'].includes(row.status) || row.service_status === 'cancelled';

        // done: already true in stored state. upcoming: scheduled, not reached.
        const steps = [
          { key: 'booking_created', state: 'done', at: row.created_at },
          { key: 'payment', state: paid ? 'done' : (cancelled ? 'cancelled' : 'pending'), at: null },
          { key: 'ticket_ready', state: row.ticket_issued > 0 ? 'done' : (paid ? 'available' : 'pending'), at: null },
          // First-mile advice is guidance, never an operational milestone.
          { key: 'leave_for_boarding_point', state: 'advice', at: plan.leaveBy, estimated: true },
          { key: 'boarding_opens', state: row.current_sequence > row.origin_sequence ? 'done' : 'upcoming', at: plan.boardingOpensAt, estimated: true },
          { key: 'departure', state: row.service_status === 'active' || row.status === 'boarded' ? 'done' : 'upcoming', at: plan.departureAt },
          { key: 'arrival', state: row.status === 'completed' ? 'done' : 'upcoming', at: plan.arrivalAt,
            scheduled: plan.arrivalScheduled },
        ];
        if (cancelled) for (const step of steps) if (['upcoming', 'advice', 'pending'].includes(step.state)) step.state = 'cancelled';

        return {
          bookingId: row.id, serviceId: row.service_id, status: row.status, serviceStatus: row.service_status,
          operatorName: row.operator_name,
          departurePoint, arrivalPoint,
          plan,
          steps,
          // The whole first/last-mile block is optional: it must never gate
          // boarding, and it degrades to the exact boarding point plus a map
          // link when no provider, map or location is available.
          firstMile: {
            optional: true,
            boardingPoint: departurePoint,
            provider: suggestion ? {
              id: suggestion.id, name: suggestion.name, integrationStatus: suggestion.integration_status,
              handoff: suggestion.integration_status === 'integrated' ? 'in_app_booking' : 'external_link',
              launchUrl: suggestion.launch_url, booksRide: false, providesFareEstimate: false, providesEta: false,
            } : null,
            directionsUrl: departurePoint?.directionsUrl ?? null,
            leaveBy: plan.leaveBy, travelMinutes: plan.travelMinutes, travelSource: plan.travelSource, estimated: true,
          },
          lastMile: {
            optional: true,
            arrivalPoint,
            provider: suggestion ? { id: suggestion.id, name: suggestion.name, integrationStatus: suggestion.integration_status,
              handoff: suggestion.integration_status === 'integrated' ? 'in_app_booking' : 'external_link',
              launchUrl: suggestion.launch_url, booksRide: false, providesFareEstimate: false, providesEta: false } : null,
            directionsUrl: arrivalPoint?.directionsUrl ?? null,
            // Only meaningful once the passenger is actually travelling.
            available: ['boarded', 'completed'].includes(row.status),
          },
        };
      });
    },
  };
}
