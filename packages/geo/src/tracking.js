import { derivedSpeedMps } from './route.js';

// Freshness and arrival estimation.
//
// Two rules govern everything here:
//   - a vehicle is "live" only while LeRoutier is actually receiving GPS;
//   - an arrival estimate is only produced from inputs that exist.
// There is no traffic provider and no historical segment data, so neither is
// claimed. When the inputs run out the answer is "unavailable", not a guess.

/** Central thresholds. Every screen reads freshness from here. */
export const FRESHNESS = { liveSeconds: 90, delayedSeconds: 300, staleSeconds: 1800 };

/**
 * How much the last observation can be trusted.
 * live → recent enough to move a marker; delayed → signal is lagging;
 * stale → last known position only; unavailable → nothing usable.
 */
export function freshness(observedAt, now = Date.now(), thresholds = FRESHNESS) {
  if (!observedAt) return { state: 'unavailable', ageSeconds: null };
  const ageSeconds = Math.round((now - Date.parse(observedAt)) / 1000);
  if (!Number.isFinite(ageSeconds) || ageSeconds < -60) return { state: 'unavailable', ageSeconds: null };
  const age = Math.max(0, ageSeconds);
  if (age <= thresholds.liveSeconds) return { state: 'live', ageSeconds: age };
  if (age <= thresholds.delayedSeconds) return { state: 'delayed', ageSeconds: age };
  if (age <= thresholds.staleSeconds) return { state: 'stale', ageSeconds: age };
  return { state: 'unavailable', ageSeconds: age };
}

/**
 * Arrival estimate for a distance remaining along the road.
 *
 * Confidence is explicit and degrades honestly:
 *   live      — recent GPS and usable measured movement;
 *   estimated — GPS position known, movement inferred from the route default;
 *   scheduled — no usable GPS; the operator's timetable is all we have;
 *   unavailable — not enough to say anything.
 *
 * Uses: remaining road distance, recent GPS observations, the schedule.
 * Does NOT use: traffic conditions, historical segment times, or any
 * third-party prediction — none of which this system has.
 */
/**
 * @param {{ remainingM?: number|null, observations?: any[], observedAt?: string|null,
 *   scheduledAt?: string|null, now?: number, speedMps?: number|null,
 *   routeDurationS?: number|null, routeDistanceM?: number|null, disrupted?: boolean,
 *   thresholds?: { liveSeconds: number, delayedSeconds: number, staleSeconds: number } }} [input]
 */
export function estimateArrival({
  remainingM = null, observations = [], observedAt = null, scheduledAt = null,
  now = Date.now(), speedMps = null, thresholds = FRESHNESS,
  routeDurationS = null, routeDistanceM = null, disrupted = false,
} = {}) {
  const signal = freshness(observedAt, now, thresholds);
  const scheduleTime = Date.parse(scheduledAt);
  const scheduled = Number.isFinite(scheduleTime) && scheduleTime >= now ? new Date(scheduleTime).toISOString() : null;
  if (disrupted) return {at:null,confidence:'unavailable',source:null,signal:signal.state,reason:'service_disrupted'};

  // Without a usable position, the timetable is the only honest answer.
  if (!Number.isFinite(remainingM) || ['stale','unavailable'].includes(signal.state)) {
    return scheduled
      ? { at: scheduled, confidence: 'scheduled', source: 'schedule', signal: signal.state }
      : { at: null, confidence: 'unavailable', source: null, signal: signal.state };
  }

  const measured = Number.isFinite(speedMps) && speedMps > 1 ? speedMps : derivedSpeedMps(observations);
  const usableMeasured = Number.isFinite(measured) && measured > 1;
  // Measured movement only counts while the signal is genuinely recent; a
  // stale fix cannot support a "live" estimate.
  const live = usableMeasured && signal.state === 'live';
  const routedSpeed = routeDurationS > 0 && routeDistanceM > 0 ? routeDistanceM / routeDurationS : null;
  const effective = usableMeasured ? measured : routedSpeed;
  if (!(effective > 0)) return scheduled
    ? {at:scheduled,confidence:'scheduled',source:'schedule',signal:signal.state}
    : {at:null,confidence:'unavailable',source:null,signal:signal.state};
  const seconds = remainingM / effective;
  if (!Number.isFinite(seconds) || seconds < 0) {
    return scheduled ? { at: scheduled, confidence: 'scheduled', source: 'schedule', signal: signal.state }
      : { at: null, confidence: 'unavailable', source: null, signal: signal.state };
  }

  // Rounded to five minutes: the inputs do not support minute precision, and
  // showing "14:24:37" would imply an accuracy this system does not have.
  const raw = now + seconds * 1000;
  const at = new Date(Math.ceil(raw / 300_000) * 300_000).toISOString();
  return {
    at,
    confidence: live ? 'live' : 'estimated',
    source: usableMeasured ? 'gps_movement' : 'road_routing',
    signal: signal.state,
    speedMps: usableMeasured ? Math.round(measured * 10) / 10 : null,
    scheduledAt: scheduled,
  };
}

/**
 * Decide whether a device fix is worth sending to the server.
 * Sends when the vehicle has actually moved, or when enough time has passed to
 * prove the signal is still alive — so a parked bus does not drain a phone and
 * a moving one is not under-reported. Thresholds are configurable.
 */
export function shouldPublishPosition(candidate, last, { minMetres = 120, maxSeconds = 45, maxAccuracyM = 200 } = {}) {
  if (!candidate || !Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude)) return false;
  // A fix this vague says nothing useful about where a bus is.
  if (Number.isFinite(candidate.accuracyM) && candidate.accuracyM > maxAccuracyM) return false;
  if (!last) return true;
  const seconds = (Date.parse(candidate.observedAt) - Date.parse(last.observedAt)) / 1000;
  if (!(seconds > 0)) return false;
  if (seconds >= maxSeconds) return true;
  const metres = haversine(candidate, last);
  return metres >= minMetres;
}

const haversine = (a, b) => {
  const R = 6_371_000, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude), dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
