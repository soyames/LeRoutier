import { invariant } from '@leroutier/domain';

export function validatePosition({ latitude, longitude, observedAt }, now = Date.now()) {
  invariant(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180,
  'INVALID_POSITION', 'Coordinates are invalid.');
  const time = Date.parse(observedAt);
  invariant(Number.isFinite(time) && time <= now + 60_000 && time >= now - 24 * 3600_000,
    'INVALID_POSITION_TIME', 'Position time is outside the accepted window.');
  return { latitude, longitude, observedAt: new Date(time).toISOString() };
}

const radians = degrees => degrees * Math.PI / 180;

// Great-circle distance in metres.
export function distanceMetres(from, to) {
  if (!from || !to || ![from.latitude, from.longitude, to.latitude, to.longitude].every(Number.isFinite)) return null;
  const earthRadius = 6_371_000;
  const dLat = radians(to.latitude - from.latitude), dLon = radians(to.longitude - from.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(a))));
}

// Coarse first-mile duration from a straight-line distance. This is explicitly
// NOT routing: it applies a detour factor and an average urban speed, and the
// caller must present the result as an estimate. Runs on the passenger's own
// device so their coordinates never reach the server.
export function localTravelEstimateMinutes(from, to, { detourFactor = 1.35, kmPerHour = 18 } = {}) {
  const metres = distanceMetres(from, to);
  if (metres === null) return null;
  return Math.max(1, Math.min(600, Math.round((metres * detourFactor / 1000) / kmPerHour * 60)));
}
