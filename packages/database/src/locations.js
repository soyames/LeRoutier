import { invariant, uuid } from '@leroutier/domain';
import { audit, activeIdentity } from './identities.js';

// Canonical operational location registry. One normalized model serves
// company stations, public bus parks, independent boarding points and
// parcel points; purposes are orthogonal to the location type.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
export const LOCATION_TYPES = ['company_station', 'public_bus_park', 'independent_boarding_point', 'roadside_pickup', 'parcel_consignment_point', 'parcel_pickup_point'];
export const LOCATION_PURPOSES = ['passenger_boarding', 'passenger_alighting', 'parcel_consignment', 'parcel_pickup'];
const publicPoint = r => ({ id: r.id, name: r.name, placeId: r.place_id, stopId: r.stop_id, type: r.type,
  description: r.description, latitude: r.latitude, longitude: r.longitude, purposes: r.purposes, status: r.status, city: r.city });

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
      invariant(actor?.role === 'ops' && !actor.operator_id, 'FORBIDDEN', 'Only platform operations can moderate locations.', 403);
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
    async stationList(actor, operatorId = undefined) {
      const id = operatorId ? uuid(operatorId) : null;
      return db.transaction(async tx => {
        const user = await activeIdentity(tx, actor.id);
        if (user.operator_id) invariant(!id || user.operator_id === id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        return (await tx.query(`SELECT s.*,b.name AS point_name,b.type AS point_type,p.name AS city FROM operator_stations s
          JOIN boarding_points b ON b.id=s.boarding_point_id JOIN places p ON p.id=b.place_id
          WHERE ($1::uuid IS NULL OR s.operator_id=$1) AND s.active=true ORDER BY s.name LIMIT 200`, [id ?? (user.role === 'ops' ? user.operator_id : null)])).rows;
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
