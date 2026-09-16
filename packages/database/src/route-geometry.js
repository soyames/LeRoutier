import { createHash } from 'node:crypto';
import { invariant, uuid } from '@leroutier/domain';
import { isValidLine, lineLengthMetres } from '@leroutier/geo';
import { RoutingUnavailable, ROUTING_REASONS } from '@leroutier/routing';
import { audit } from './identities.js';

// Road geometry for a route: generated from the ordered stops, stored once, and
// re-generated only when those stops change. A passenger opening a map never
// causes a routing call.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];

/** Deterministic fingerprint of the ordered stop coordinates. */
const fingerprint = stops => createHash('sha256')
  .update(JSON.stringify(stops.map(s => [s.sequence, s.longitude, s.latitude])))
  .digest('hex').slice(0, 32);

const ORDERED_STOPS = `SELECT rs.sequence, rs.stop_id, s.name, s.longitude, s.latitude, p.name AS city
  FROM route_stops rs JOIN stops s ON s.id=rs.stop_id JOIN places p ON p.id=s.place_id
  WHERE rs.route_id=$1 ORDER BY rs.sequence`;

export function routeGeometry(db, router) {
  /** Ordered stops of a route, with whatever coordinates they actually have. */
  async function stopsOf(tx, routeId) {
    return (await tx.query(ORDERED_STOPS, [routeId])).rows.map(r => ({
      sequence: r.sequence, stopId: r.stop_id, name: r.name, city: r.city,
      longitude: r.longitude === null ? null : Number(r.longitude),
      latitude: r.latitude === null ? null : Number(r.latitude),
    }));
  }

  return {
    stopsOf,

    /**
     * Stored geometry for a route, with whether it still matches the stops.
     * `stale` means the stops moved or were reordered since it was generated —
     * the line is still shown, but it is known to be out of date.
     */
    async read(routeId) {
      uuid(routeId);
      return db.transaction(async tx => {
        const stops = await stopsOf(tx, routeId);
        const row = await one(tx, 'SELECT * FROM route_geometries WHERE route_id=$1', [routeId]);
        const lastFailure = await one(tx,
          'SELECT reason,detail,created_at FROM route_geometry_failures WHERE route_id=$1 ORDER BY created_at DESC LIMIT 1', [routeId]);
        const missingCoordinates = stops.filter(s => s.longitude === null || s.latitude === null).map(s => s.name);
        if (!row) {
          return { available: false, stops, missingCoordinates,
            reason: lastFailure?.reason ?? (missingCoordinates.length ? ROUTING_REASONS.MISSING_COORDINATES : null),
            lastAttemptAt: lastFailure?.created_at ?? null };
        }
        return {
          available: true,
          coordinates: row.coordinates,
          distanceM: row.distance_m,
          provider: row.provider,
          generatedAt: row.generated_at,
          stale: row.input_hash !== fingerprint(stops) || row.stop_count !== stops.length,
          stops, missingCoordinates,
        };
      });
    },

    /**
     * Generate and store road geometry for a route.
     * Failures are recorded as a safe reason code for Ops and never produce a
     * fabricated line: a route with no engine, no coordinates or no road
     * connection simply has no geometry.
     */
    async generate(actor, routeId, { force = false } = {}) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      uuid(routeId);
      const prepared = await db.transaction(async tx => {
        const route = await one(tx, 'SELECT id,operator_id FROM routes WHERE id=$1', [routeId]);
        invariant(route, 'NOT_FOUND', 'Route not found.', 404);
        // A company may only route its own lines.
        invariant(!actor.operator_id || actor.operator_id === route.operator_id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        const stops = await stopsOf(tx, routeId);
        const existing = await one(tx, 'SELECT input_hash,stop_count FROM route_geometries WHERE route_id=$1', [routeId]);
        return { route, stops, existing };
      });

      const { route, stops, existing } = prepared;
      const hash = fingerprint(stops);
      // Nothing changed and nothing was asked for: do not call the engine.
      if (!force && existing && existing.input_hash === hash && existing.stop_count === stops.length) {
        return { routeId, regenerated: false, reason: null };
      }

      try {
        invariant(stops.length >= 2, 'INVALID_ROUTE', 'A route needs at least two stops.', 409);
        const { coordinates, distanceM, provider } = await router.route(stops);
        invariant(isValidLine(coordinates), 'INVALID_GEOMETRY', 'Routing geometry was malformed.', 502);
        // Trust the engine's distance, but fall back to measuring the line.
        const measured = distanceM > 0 ? distanceM : Math.round(lineLengthMetres(coordinates));
        await db.transaction(async tx => {
          await tx.query(`INSERT INTO route_geometries(route_id,coordinates,distance_m,provider,input_hash,stop_count)
            VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(route_id) DO UPDATE SET coordinates=EXCLUDED.coordinates,distance_m=EXCLUDED.distance_m,
              provider=EXCLUDED.provider,input_hash=EXCLUDED.input_hash,stop_count=EXCLUDED.stop_count,generated_at=now()`,
          [routeId, JSON.stringify(coordinates), measured, provider, hash, stops.length]);
          await tx.query('DELETE FROM route_geometry_failures WHERE route_id=$1', [routeId]);
          await audit(tx, actor.id, 'route.geometry_generated', routeId, route.operator_id,
            { provider, distanceM: measured, stopCount: stops.length });
        });
        return { routeId, regenerated: true, distanceM: measured, provider, points: coordinates.length };
      } catch (error) {
        const reason = error instanceof RoutingUnavailable ? error.reason : ROUTING_REASONS.PROVIDER_ERROR;
        const detail = error instanceof RoutingUnavailable ? error.message : 'Route geometry could not be generated.';
        await db.transaction(async tx => {
          await tx.query('INSERT INTO route_geometry_failures(route_id,reason,detail,attempted_by) VALUES($1,$2,$3,$4)',
            [routeId, reason, detail.slice(0, 300), actor.id]);
        });
        // The route stays editable and usable; only its road line is missing.
        return { routeId, regenerated: false, reason, detail };
      }
    },
  };
}
