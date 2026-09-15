export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export function invariant(condition, code, message, status = 400) {
  if (!condition) throw new DomainError(code, message, status);
}

export function journeySegments(origin, destination, stopCount) {
  invariant(Number.isInteger(origin) && Number.isInteger(destination) &&
    origin >= 0 && origin < destination && destination < stopCount,
  'INVALID_JOURNEY', 'Choose an origin before the destination.');
  return Array.from({ length: destination - origin }, (_, offset) => origin + offset);
}

export const occupyingStatuses = ['held', 'confirmed', 'boarded'];

export function occupiedBySegment(stopCount, bookings, now = Date.now()) {
  const occupied = Array(stopCount - 1).fill(0);
  for (const booking of bookings) {
    if (!occupyingStatuses.includes(booking.status)) continue;
    if (booking.status === 'held' && new Date(booking.expiresAt).getTime() <= now) continue;
    for (const segment of journeySegments(booking.origin, booking.destination, stopCount)) {
      occupied[segment] += booking.quantity ?? 1;
    }
  }
  return occupied;
}

export function availableCapacity(capacity, occupied, origin, destination) {
  invariant(Number.isInteger(capacity) && capacity > 0, 'INVALID_CAPACITY', 'Capacity must be positive.');
  return Math.max(0, Math.min(...journeySegments(origin, destination, occupied.length + 1)
    .map(segment => capacity - occupied[segment])));
}

export function validateTransition(status, action) {
  const transitions = {
    confirm: { held: 'confirmed' }, cancel: { held: 'cancelled', confirmed: 'cancelled' },
    expire: { held: 'expired' }, board: { confirmed: 'boarded' }, alight: { boarded: 'completed' },
  };
  const next = transitions[action]?.[status];
  invariant(next, 'INVALID_TRANSITION', 'This booking action is not available.', 409);
  return next;
}

export function uuid(value) {
  invariant(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    'INVALID_ID', 'A valid identifier is required.');
  return value;
}

export function idempotencyKey(value) {
  invariant(typeof value === 'string' && /^[\w-]{8,100}$/.test(value), 'INVALID_KEY', 'A valid Idempotency-Key is required.');
  return value;
}

// First-mile timing policy. One configurable default instead of buffers
// scattered through screens and workers; overridable per deployment.
// Worked example with these defaults: departure 07:30 gives boarding from
// 07:10, be-there-by 07:15, and a 25-minute local trip leaves home at 06:40.
export const FIRST_MILE_POLICY = {
  boardingOpensMinutes: 20,
  recommendedArrivalMinutes: 15,
  boardingClosesMinutes: 5,
  safetyBufferMinutes: 10,
  defaultLocalTravelMinutes: 25,
};

// Schedule-derived journey plan. Pure: no database, no provider, no location.
// localTravelMinutes is supplied per request and never stored — when it is
// absent the policy default is used and the result is marked as an estimate,
// because LeRoutier has no live routing and must not imply that it does.
// The database driver returns timestamps as Date objects while the API
// receives ISO strings: Date.parse() on a Date coerces through String() and
// silently loses the milliseconds, so both forms go through new Date().
const instant = value => (value === null || value === undefined ? NaN : new Date(value).getTime());

export function journeyPlan({ departureAt, arrivalAt = null, localTravelMinutes = null, policy = FIRST_MILE_POLICY }) {
  const departure = instant(departureAt);
  invariant(Number.isFinite(departure), 'INVALID_SCHEDULE', 'Departure time is invalid.');
  const arrival = arrivalAt === null || arrivalAt === undefined ? null : instant(arrivalAt);
  invariant(arrival === null || (Number.isFinite(arrival) && arrival > departure), 'INVALID_SCHEDULE', 'Arrival time is invalid.');
  invariant(localTravelMinutes === null || (Number.isInteger(localTravelMinutes) && localTravelMinutes >= 0 && localTravelMinutes <= 600),
    'INVALID_TRAVEL_ESTIMATE', 'Local travel estimate is invalid.');
  const at = minutes => new Date(departure - minutes * 60_000).toISOString();
  const travelMinutes = localTravelMinutes ?? policy.defaultLocalTravelMinutes;
  return {
    departureAt: new Date(departure).toISOString(),
    arrivalAt: arrival === null ? null : new Date(arrival).toISOString(),
    // Null arrival means "not scheduled by the operator" — never a guess.
    arrivalScheduled: arrival !== null,
    boardingOpensAt: at(policy.boardingOpensMinutes),
    boardingClosesAt: at(policy.boardingClosesMinutes),
    beThereBy: at(policy.recommendedArrivalMinutes),
    leaveBy: at(policy.recommendedArrivalMinutes + travelMinutes + policy.safetyBufferMinutes),
    travelMinutes,
    safetyBufferMinutes: policy.safetyBufferMinutes,
    // No live routing provider is integrated: every travel time here is an
    // estimate and the UI must label it as one.
    travelSource: localTravelMinutes === null ? 'policy_default' : 'client_estimate',
    estimated: true,
  };
}
