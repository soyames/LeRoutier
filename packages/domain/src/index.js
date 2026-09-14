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
