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
