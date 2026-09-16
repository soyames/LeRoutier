// Route geometry: where a vehicle is along a real road line.
//
// All inputs are GeoJSON-style [longitude, latitude] pairs, which is what
// routing engines return. Everything here is pure and deterministic: no
// network, no clock, no provider. The hard cases — a stop behind the vehicle,
// a noisy GPS sample, a route that doubles back — are handled by measuring
// along the line rather than as the crow flies.

const EARTH_RADIUS_M = 6_371_000;
const toRad = degrees => (degrees * Math.PI) / 180;

/** Great-circle distance in metres between two [lon, lat] points. */
export function haversineMetres([lon1, lat1], [lon2, lat2]) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A coordinate array is usable only if it is a line of valid lon/lat pairs. */
export function isValidLine(coordinates) {
  return Array.isArray(coordinates) && coordinates.length >= 2 && coordinates.every(point =>
    Array.isArray(point) && point.length >= 2 &&
    Number.isFinite(point[0]) && point[0] >= -180 && point[0] <= 180 &&
    Number.isFinite(point[1]) && point[1] >= -90 && point[1] <= 90);
}

/**
 * Cumulative distance in metres at each vertex, so `at[i]` is how far along the
 * route vertex `i` sits. Computed once and reused for every projection.
 */
export function cumulativeDistances(coordinates) {
  const at = [0];
  for (let i = 1; i < coordinates.length; i++) at.push(at[i - 1] + haversineMetres(coordinates[i - 1], coordinates[i]));
  return at;
}

/** Total road distance of the line, in metres. */
export const lineLengthMetres = coordinates => (isValidLine(coordinates) ? cumulativeDistances(coordinates).at(-1) : 0);

// Local planar projection in metres around a reference latitude. Over a bus
// route this is indistinguishable from a proper projection and keeps the
// segment maths simple and fast.
const planar = ([lon, lat], refLat) => [toRad(lon) * EARTH_RADIUS_M * Math.cos(toRad(refLat)), toRad(lat) * EARTH_RADIUS_M];

/**
 * Nearest point on the route to `point`.
 * @returns {{ segment: number, distanceAlongM: number, offRouteM: number, point: [number,number] }}
 */
export function nearestOnRoute(coordinates, point, at = cumulativeDistances(coordinates)) {
  let best = { segment: 0, distanceAlongM: 0, offRouteM: Infinity, point: coordinates[0] };
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = coordinates[i], b = coordinates[i + 1];
    const refLat = (a[1] + b[1]) / 2;
    const [ax, ay] = planar(a, refLat), [bx, by] = planar(b, refLat), [px, py] = planar(point, refLat);
    const dx = bx - ax, dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    // A zero-length segment (duplicate vertex) projects onto its own start.
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    const projected = /** @type {[number, number]} */ ([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    const offRouteM = haversineMetres(/** @type {[number, number]} */ (point), projected);
    if (offRouteM < best.offRouteM) {
      best = { segment: i, distanceAlongM: at[i] + (at[i + 1] - at[i]) * t, offRouteM, point: projected };
    }
  }
  return best;
}

/**
 * Where the vehicle is along the route.
 * `previousAlongM` keeps progress monotonic: a noisy sample that projects
 * backwards does not rewind the journey, which would make a passenger's
 * remaining distance jump around.
 */
export function routeProgress(coordinates, point, { previousAlongM = null } = {}) {
  if (!isValidLine(coordinates) || !Array.isArray(point)) return null;
  const at = cumulativeDistances(coordinates);
  const total = at.at(-1);
  const nearest = nearestOnRoute(coordinates, point, at);
  const distanceAlongM = previousAlongM === null ? nearest.distanceAlongM : Math.max(previousAlongM, nearest.distanceAlongM);
  return {
    totalM: Math.round(total),
    distanceAlongM: Math.round(distanceAlongM),
    remainingM: Math.round(Math.max(0, total - distanceAlongM)),
    progress: total > 0 ? Math.min(1, Math.max(0, distanceAlongM / total)) : 0,
    offRouteM: Math.round(nearest.offRouteM),
    segment: nearest.segment,
    snapped: nearest.point,
  };
}

/**
 * Project ordered stops onto the route so "next stop" can be decided by
 * position along the line rather than by which stop happens to be closest —
 * the nearest stop is often the one already behind the vehicle.
 *
 * Projection is monotonic by construction: each stop is searched only from the
 * previous stop's position onward, so a route that passes near an earlier stop
 * again cannot pull a later stop backwards.
 */
export function projectStops(coordinates, stops) {
  if (!isValidLine(coordinates)) return [];
  const at = cumulativeDistances(coordinates);
  let floor = 0;
  return stops.map(stop => {
    if (!Number.isFinite(stop.longitude) || !Number.isFinite(stop.latitude)) {
      return { ...stop, distanceAlongM: null, offRouteM: null };
    }
    const nearest = nearestOnRoute(coordinates, [stop.longitude, stop.latitude], at);
    const distanceAlongM = Math.max(floor, nearest.distanceAlongM);
    floor = distanceAlongM;
    return { ...stop, distanceAlongM: Math.round(distanceAlongM), offRouteM: Math.round(nearest.offRouteM) };
  });
}

/**
 * The next stop ahead of the vehicle.
 * `reachedSequence` is the operational truth — the stop crew have actually
 * recorded arriving at — and always wins over GPS. GPS only advances the guess
 * beyond it, never behind it.
 */
export function nextStopFrom(projected, distanceAlongM, { reachedSequence = -1, arrivalRadiusM = 150 } = {}) {
  const ahead = projected.filter(stop =>
    stop.distanceAlongM !== null &&
    stop.sequence > reachedSequence &&
    stop.distanceAlongM > distanceAlongM - arrivalRadiusM);
  return ahead[0] ?? null;
}

/**
 * Passing state per stop, for the journey timeline. Conservative: GPS marks a
 * stop "passed" only when the vehicle is clearly beyond it, and an operational
 * arrival always outranks the GPS guess.
 */
export function stopStates(projected, distanceAlongM, { reachedSequence = -1, arrivalRadiusM = 150 } = {}) {
  const next = nextStopFrom(projected, distanceAlongM, { reachedSequence, arrivalRadiusM });
  return projected.map(stop => {
    if (stop.sequence <= reachedSequence) return { ...stop, state: 'passed' };
    if (stop.distanceAlongM === null) return { ...stop, state: 'upcoming' };
    if (stop.distanceAlongM < distanceAlongM - arrivalRadiusM) return { ...stop, state: 'passed' };
    if (next && stop.sequence === next.sequence) {
      return { ...stop, state: Math.abs(stop.distanceAlongM - distanceAlongM) <= arrivalRadiusM ? 'arriving' : 'next' };
    }
    return { ...stop, state: 'upcoming' };
  });
}

/**
 * Sustained deviation, not a single noisy sample.
 * A vehicle counts as off route only when consecutive observations are all
 * beyond tolerance, and a sample whose own GPS accuracy is worse than the
 * deviation proves nothing and is ignored.
 */
export function offRouteState(samples, { toleranceM = 250, consecutive = 3 } = {}) {
  const usable = samples.filter(sample =>
    Number.isFinite(sample.offRouteM) &&
    // An accuracy circle wider than the deviation cannot establish deviation.
    (!Number.isFinite(sample.accuracyM) || sample.accuracyM < sample.offRouteM));
  const recent = usable.slice(-consecutive);
  const off = recent.length >= consecutive && recent.every(sample => sample.offRouteM > toleranceM);
  return { offRoute: off, worstOffRouteM: recent.length ? Math.max(...recent.map(s => s.offRouteM)) : null, samples: recent.length };
}

/**
 * Speed in metres per second from consecutive observations.
 * Device-reported speed is preferred when present and plausible; otherwise it
 * is derived from movement over time. Implausible values are discarded rather
 * than smoothed, so one bad fix cannot distort an arrival estimate.
 */
export function derivedSpeedMps(observations, { maxPlausibleMps = 45 } = {}) {
  const points = observations
    .filter(o => Number.isFinite(o.longitude) && Number.isFinite(o.latitude) && o.observedAt)
    .slice(-6);
  if (points.length < 2) return null;
  const speeds = [];
  for (let i = 1; i < points.length; i++) {
    const seconds = (Date.parse(points[i].observedAt) - Date.parse(points[i - 1].observedAt)) / 1000;
    if (!(seconds > 0)) continue;
    const metres = haversineMetres([points[i - 1].longitude, points[i - 1].latitude], [points[i].longitude, points[i].latitude]);
    const mps = metres / seconds;
    if (mps >= 0 && mps <= maxPlausibleMps) speeds.push(mps);
  }
  if (!speeds.length) return null;
  // Median: resistant to a single jump between two fixes.
  const sorted = [...speeds].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
