import { invariant, uuid } from '@leroutier/domain';

// First/last-mile mobility providers. LeRoutier does not resell these rides.
// A provider stays 'suggested_external' until a real integration exists, and
// every response says so explicitly, so no screen can imply that LeRoutier
// booked a ride, quoted a fare or knows a provider ETA.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
export const LEGS = ['first_mile', 'last_mile'];
export const HANDOFF_KINDS = ['suggestion_viewed', 'handoff_clicked', 'directions_clicked', 'self_selected'];

// Generic directions fallback: works with any map application and needs no
// provider relationship. Used when no provider serves the country.
export function directionsUrl(point) {
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return null;
  return `https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=17/${point.latitude}/${point.longitude}`;
}

const publicProvider = r => ({
  id: r.id, name: r.name, country: r.country, capabilities: r.capabilities,
  integrationStatus: r.integration_status,
  // handoff describes what actually happens when the passenger taps: we open
  // the provider's own app or site and they take it from there.
  handoff: r.integration_status === 'integrated' ? 'in_app_booking' : 'external_link',
  launchUrl: r.launch_url,
  booksRide: r.integration_status === 'integrated',
  providesFareEstimate: false,
  providesEta: false,
});

export function mobility(db) {
  return {
    async providers(actor, { country = 'BJ', leg = 'first_mile' } = {}) {
      invariant(typeof country === 'string' && /^[A-Za-z]{2}$/.test(country), 'INVALID_QUERY', 'Country is invalid.');
      invariant(LEGS.includes(leg), 'INVALID_QUERY', 'Leg must be first_mile or last_mile.');
      return db.transaction(async tx => (await tx.query(
        `SELECT * FROM mobility_providers WHERE active AND country=$1 AND capabilities @> $2::jsonb ORDER BY name`,
        [country.toUpperCase(), JSON.stringify([leg])])).rows.map(publicProvider));
    },
    // Funnel measurement only. Stores no coordinates and never asserts that a
    // ride happened: a click is a click until a real integration confirms one.
    async recordHandoff(actor, input) {
      invariant(actor?.id, 'UNAUTHORIZED', 'Sign in to continue.', 401);
      invariant(input && Object.keys(input).every(k => ['providerId', 'bookingId', 'leg', 'kind'].includes(k)),
        'INVALID_HANDOFF', 'Unexpected handoff fields.');
      invariant(LEGS.includes(input.leg), 'INVALID_HANDOFF', 'Leg is invalid.');
      invariant(HANDOFF_KINDS.includes(input.kind), 'INVALID_HANDOFF', 'Handoff kind is invalid.');
      invariant(input.providerId === undefined || input.providerId === null ||
        (typeof input.providerId === 'string' && input.providerId.length <= 50), 'INVALID_HANDOFF', 'Provider is invalid.');
      if (input.bookingId) uuid(input.bookingId);
      return db.transaction(async tx => {
        if (input.bookingId) {
          const booking = await one(tx, 'SELECT id FROM bookings WHERE id=$1 AND passenger_id=$2', [input.bookingId, actor.id]);
          invariant(booking, 'NOT_FOUND', 'Booking not found.', 404);
        }
        if (input.providerId) {
          invariant(await one(tx, 'SELECT id FROM mobility_providers WHERE id=$1 AND active', [input.providerId]),
            'NOT_FOUND', 'Provider not found.', 404);
        }
        const row = await one(tx, `INSERT INTO mobility_handoff_events(user_id,provider_id,booking_id,leg,kind)
          VALUES($1,$2,$3,$4,$5) RETURNING id,leg,kind,created_at`,
        [actor.id, input.providerId ?? null, input.bookingId ?? null, input.leg, input.kind]);
        // Explicit: recording a click is not recording a completed ride.
        return { id: row.id, leg: row.leg, kind: row.kind, recordedAt: row.created_at, rideCompleted: false };
      });
    },
  };
}
