import { invariant, uuid } from '@leroutier/domain';
import { requirePlatform } from './platform-access.js';
import { audit, activeIdentity } from './identities.js';

// Canonical operational location registry. One normalized model serves
// company stations, public bus parks, independent boarding points and
// parcel points; purposes are orthogonal to the location type.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
export const LOCATION_TYPES = ['company_station', 'public_bus_park', 'independent_boarding_point', 'roadside_pickup', 'parcel_consignment_point', 'parcel_pickup_point'];
export const LOCATION_PURPOSES = ['passenger_boarding', 'passenger_alighting', 'parcel_consignment', 'parcel_pickup'];
const publicPoint = r => ({ id: r.id, name: r.name, placeId: r.place_id, stopId: r.stop_id, type: r.type,
  description: r.description, latitude: r.latitude, longitude: r.longitude, purposes: r.purposes, status: r.status, city: r.city });

/** More points than a viewport can usefully draw, so more is never asked for. */
export const MAX_MAP_POINTS = 200;
/** The largest viewport points are drawn for: Benin and its neighbours, no more. */
export const MAX_VIEWPORT_SQUARE_DEGREES = 60;

export function locations(db) {
  return {
    async search(actor, input) {
      invariant(input && Object.keys(input).every(k => ['q', 'placeId', 'purposes', 'includeProposed'].includes(k)),
        'INVALID_QUERY', 'Unexpected search fields.');
      const q = typeof input.q === 'string' ? input.q.slice(0, 100) : '';
      invariant(input.placeId === undefined || input.placeId === null || typeof input.placeId === 'string', 'INVALID_QUERY', 'Invalid place.');
      if (input.placeId) uuid(input.placeId);
      invariant(input.purposes === undefined || (Array.isArray(input.purposes) && input.purposes.every(p => LOCATION_PURPOSES.includes(p))),
        'INVALID_QUERY', 'Invalid purposes.');
      const includeProposed = input.includeProposed === true;
      return db.transaction(async tx => (await tx.query(`SELECT b.*,p.name AS city FROM boarding_points b JOIN places p ON p.id=b.place_id
        WHERE ($1::text='' OR b.name ILIKE '%'||$1||'%') AND ($2::uuid IS NULL OR b.place_id=$2)
        AND ($3::jsonb IS NULL OR b.purposes @> $3::jsonb)
        AND (b.status='verified' OR $4)
        ORDER BY (b.status='verified') DESC,b.name LIMIT 100`,
      [q, input.placeId ?? null, input.purposes ? JSON.stringify(input.purposes) : null, includeProposed])).rows.map(publicPoint));
    },
    /**
     * Every published place a journey passes through, inside one viewport.
     *
     * WHAT THIS IS FOR. A map of Benin with a route drawn on it answers "where
     * is the bus"; it does not answer "where do I get on", which is the
     * question somebody actually has at a roadside. The answer already exists
     * in LeRoutier's own registry — verified boarding points, stations and
     * stops, each with coordinates a person walked to — and this is that
     * registry, read for a map rather than for a form.
     *
     * WHY IT IS BOUNDED BY A VIEWPORT. "All the points in the country" is not
     * a question a map asks; it is a question a scraper asks. A bounding box is
     * the map's own unit of interest, a map that is zoomed out far enough to
     * want everything is one where dots would be unreadable anyway, and the
     * span is capped so the box cannot be widened until it means everything.
     *
     * WHAT IT WILL NOT RETURN. Only VERIFIED points: a proposal somebody typed
     * is not a place until a person has accepted it. Only points with
     * coordinates: a pin that cannot be drawn is not a point. And no operator,
     * no contact and no moderation state — a map of where to board is not a
     * directory of who owns the kerb.
     *
     * @param {{bbox: {minLongitude:number,minLatitude:number,maxLongitude:number,maxLatitude:number}, limit?: number}} input
     */
    async mapPoints(input) {
      const box = input?.bbox;
      invariant(box && ['minLongitude', 'minLatitude', 'maxLongitude', 'maxLatitude'].every(key => Number.isFinite(box[key])),
        'INVALID_VIEWPORT', 'A map viewport is required.');
      const { minLongitude, minLatitude, maxLongitude, maxLatitude } = box;
      invariant(minLongitude >= -180 && maxLongitude <= 180 && minLatitude >= -90 && maxLatitude <= 90
        && minLongitude < maxLongitude && minLatitude < maxLatitude,
        'INVALID_VIEWPORT', 'A map viewport is required.');
      // Roughly the whole of Benin with room to pan, and nothing larger. The
      // cap is what stops "one viewport" from becoming "the world".
      invariant((maxLongitude - minLongitude) * (maxLatitude - minLatitude) <= MAX_VIEWPORT_SQUARE_DEGREES,
        'INVALID_VIEWPORT', 'This viewport is too large to draw points for.', 422);
      const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), MAX_MAP_POINTS) : MAX_MAP_POINTS;
      const bbox = [minLongitude, minLatitude, maxLongitude, maxLatitude];
      return db.transaction(async tx => (await tx.query(
        `SELECT id,kind,name,city,type,purposes,latitude,longitude FROM (
           SELECT b.id,'boarding_point' AS kind,b.name,p.name AS city,b.type,b.purposes,
             b.latitude,b.longitude
           FROM boarding_points b JOIN places p ON p.id=b.place_id
           WHERE b.status='verified' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
           UNION ALL
           SELECT s.id,'stop' AS kind,s.name,p.name AS city,NULL AS type,'[]'::jsonb AS purposes,
             s.latitude,s.longitude
           FROM stops s JOIN places p ON p.id=s.place_id
           WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL AND NOT s.is_demo
         ) points
         WHERE longitude BETWEEN $1 AND $3 AND latitude BETWEEN $2 AND $4
         ORDER BY (kind='boarding_point') DESC, city, name
         LIMIT $5`, [...bbox, limit])).rows.map(row => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        city: row.city,
        // The registry's own vocabulary, so a map label and a checkout screen
        // never describe the same kerb two different ways.
        type: row.type,
        purposes: row.purposes ?? [],
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      })));
    },

    // Any authenticated user may propose a missing point; proposals are
    // moderated — only verified points become trusted canonical locations.
    async propose(actor, input) {
      invariant(input && Object.keys(input).every(k => ['name', 'placeId', 'stopId', 'type', 'description', 'latitude', 'longitude', 'purposes'].includes(k)),
        'INVALID_POINT', 'Unexpected point fields.');
      invariant(typeof input.name === 'string' && input.name.trim().length >= 2 && input.name.length <= 200, 'INVALID_POINT', 'A location name is required.');
      uuid(input.placeId);
      if (input.stopId) uuid(input.stopId);
      invariant(LOCATION_TYPES.includes(input.type), 'INVALID_POINT', 'Location type is invalid.');
      const purposes = input.purposes ?? [];
      invariant(Array.isArray(purposes) && purposes.length > 0 && purposes.every(p => LOCATION_PURPOSES.includes(p)),
        'INVALID_POINT', 'At least one valid purpose is required.');
      invariant(input.description === undefined || input.description === null || (typeof input.description === 'string' && input.description.length <= 1000),
        'INVALID_POINT', 'Description is too long.');
      const latitude = input.latitude === undefined || input.latitude === null ? null : Number(input.latitude);
      const longitude = input.longitude === undefined || input.longitude === null ? null : Number(input.longitude);
      invariant(latitude === null || (Number.isFinite(latitude) && latitude >= -90 && latitude <= 90), 'INVALID_POINT', 'Latitude is invalid.');
      invariant(longitude === null || (Number.isFinite(longitude) && longitude >= -180 && longitude <= 180), 'INVALID_POINT', 'Longitude is invalid.');
      return db.transaction(async tx => {
        await activeIdentity(tx, actor.id);
        invariant(await one(tx, 'SELECT id FROM places WHERE id=$1', [input.placeId]), 'NOT_FOUND', 'Place not found.', 404);
        if (input.stopId) invariant(await one(tx, 'SELECT id FROM stops WHERE id=$1 AND place_id=$2', [input.stopId, input.placeId]), 'NOT_FOUND', 'Stop does not belong to this place.', 404);
        // Duplicate detection: an existing verified or proposed point with the
        // same normalized name in the same place blocks new proposals.
        const duplicate = await one(tx, `SELECT * FROM boarding_points WHERE lower(name)=lower($1) AND place_id=$2
          AND status<>'rejected' ORDER BY (status='verified') DESC LIMIT 1`, [input.name.trim(), input.placeId]);
        invariant(!duplicate, 'DUPLICATE_POINT', 'Cette adresse existe déjà dans la localité — utilisez-la plutôt que d’en créer une nouvelle.', 409);
        const row = await one(tx, `INSERT INTO boarding_points(name,place_id,stop_id,type,description,latitude,longitude,purposes,status,proposed_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'proposed',$9) RETURNING *`,
        [input.name.trim(), input.placeId, input.stopId ?? null, input.type, input.description ?? null, latitude, longitude, JSON.stringify(purposes), actor.id]);
        await audit(tx, actor.id, 'location.proposed', row.id, null, { name: row.name, placeId: row.place_id });
        await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',
          ['location.proposed', row.id, JSON.stringify({ pointId: row.id, name: row.name, placeId: row.place_id })]);
        return publicPoint(row);
      });
    },
    // Platform moderation of proposals.
    async moderate(actor, pointId, decision) {
      requirePlatform(actor, 'provisioning');
      invariant(['verified', 'rejected'].includes(decision), 'INVALID_DECISION', 'Decision must be verified or rejected.');
      return db.transaction(async tx => {
        const row = await one(tx, 'SELECT * FROM boarding_points WHERE id=$1 FOR UPDATE', [uuid(pointId)]);
        invariant(row, 'NOT_FOUND', 'Location not found.', 404);
        if (decision === 'verified') {
          invariant(row.status === 'proposed', 'INVALID_TRANSITION', 'Only proposed locations can be verified.', 409);
        } else {
          invariant(row.status === 'proposed', 'INVALID_TRANSITION', 'Only proposed locations can be rejected.', 409);
        }
        const updated = await one(tx, 'UPDATE boarding_points SET status=$2,verified_by=$3,updated_at=now() WHERE id=$1 RETURNING *', [row.id, decision, actor.id]);
        // audit() also publishes 'location.moderated' to the outbox, which is
        // what tells the proposer the outcome — no second emit here.
        await audit(tx, actor.id, 'location.moderated', row.id, null, { from: row.status, decision });
        return publicPoint(updated);
      });
    },
    // Operator stations: a company affiliates itself with a verified location.
    // An operator's station register is operator-internal. The scope is always
    // resolved to one named operator and then required to be the caller's own:
    // the previous "refuse when the caller belongs to another operator" form
    // was satisfied by a caller belonging to NO operator — every passenger —
    // and an absent operator left the query unscoped across the platform.
    async stationList(actor, operatorId = undefined) {
      const id = operatorId ? uuid(operatorId) : null;
      return db.transaction(async tx => {
        const user = await activeIdentity(tx, actor.id);
        const scope = id ?? user.operator_id ?? null;
        const platform = user.role === 'ops' && !user.operator_id;
        invariant(scope && (user.operator_id === scope || platform), 'FORBIDDEN', 'Operation is not permitted.', 403);
        return (await tx.query(`SELECT s.*,b.name AS point_name,b.type AS point_type,p.name AS city FROM operator_stations s
          JOIN boarding_points b ON b.id=s.boarding_point_id JOIN places p ON p.id=b.place_id
          WHERE s.operator_id=$1 AND s.active=true ORDER BY s.name LIMIT 200`, [scope])).rows;
      });
    },
    async stationCreate(actor, input) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      invariant(input && Object.keys(input).every(k => ['operatorId', 'boardingPointId', 'name', 'address', 'purposes'].includes(k)),
        'INVALID_STATION', 'Unexpected station fields.');
      uuid(input.operatorId); uuid(input.boardingPointId);
      invariant(typeof input.name === 'string' && input.name.trim().length >= 2 && input.name.length <= 200, 'INVALID_STATION', 'A station name is required.');
      const purposes = input.purposes ?? [];
      invariant(Array.isArray(purposes) && purposes.length > 0 && purposes.every(p => LOCATION_PURPOSES.includes(p)), 'INVALID_STATION', 'Purposes are invalid.');
      return db.transaction(async tx => {
        const user = await activeIdentity(tx, actor.id);
        invariant(!user.operator_id || user.operator_id === input.operatorId, 'FORBIDDEN', 'Operation is not permitted.', 403);
        const point = await one(tx, "SELECT * FROM boarding_points WHERE id=$1 AND status='verified'", [input.boardingPointId]);
        invariant(point, 'INVALID_POINT', 'Only verified locations can host a station.', 409);
        const row = await one(tx, `INSERT INTO operator_stations(operator_id,boarding_point_id,name,address,purposes)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(operator_id,boarding_point_id) DO UPDATE SET active=true,address=EXCLUDED.address,purposes=EXCLUDED.purposes
          RETURNING *`, [input.operatorId, input.boardingPointId, input.name.trim(), input.address ?? null, JSON.stringify(purposes)]);
        await audit(tx, actor.id, 'operator.station_created', row.id, input.operatorId, { pointId: input.boardingPointId });
        return row;
      });
    },
  };
}
