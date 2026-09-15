import { createHash, randomBytes } from 'node:crypto';
import { invariant, uuid, idempotencyKey } from '@leroutier/domain';
import { audit } from './identities.js';

// Parcel Logistics v1 domain service. Lifecycle, chain of custody, secure
// labels, pickup verification, separate accounting and fail-closed pricing.
// Agents reach this only through the versioned API/workflow layer.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const emit = (tx, type, id, payload = {}) => tx.query(
  'INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)', [type, id, JSON.stringify(payload)]);

const STATUSES = ['created', 'accepted', 'manifested', 'loaded', 'in_transit', 'arrived', 'ready_for_pickup',
  'collected', 'cancelled', 'rejected', 'held', 'damaged', 'lost', 'return_requested', 'returned'];
const TRANSITIONS = {
  created: ['accepted', 'rejected', 'cancelled'],
  accepted: ['manifested', 'cancelled'],
  manifested: ['loaded', 'cancelled'],
  loaded: ['in_transit', 'held', 'damaged', 'lost'],
  in_transit: ['arrived', 'held', 'damaged', 'lost'],
  arrived: ['ready_for_pickup', 'held', 'damaged', 'lost'],
  ready_for_pickup: ['collected', 'return_requested', 'damaged', 'lost'],
  held: ['loaded', 'cancelled'],
  damaged: ['return_requested'],
  return_requested: ['returned'],
  collected: [], rejected: [], lost: [], returned: [], cancelled: [],
};
const EXCEPTION_STATUS = { damaged: 'damaged', lost: 'lost', rejected: 'rejected', held: 'held', return_requested: 'return_requested' };

const publicParcel = (row, parties = null) => ({
  id: row.id, trackingNumber: row.tracking_number, operatorId: row.operator_id,
  originStopId: row.origin_stop_id, destinationStopId: row.destination_stop_id,
  category: row.category, quantity: row.quantity, weightG: row.weight_g, dimensions: row.dimensions,
  declaredValueMinor: row.declared_value_minor, notes: row.notes,
  paymentResponsibility: row.payment_responsibility, priceMinor: row.price_minor,
  status: row.status, etaAt: row.eta_at, createdAt: row.created_at, updatedAt: row.updated_at,
  parties: parties ? parties.reduce((acc, p) => { acc[p.role] = { name: p.name, phone: p.phone }; return acc; }, {}) : undefined,
});
const driverParcel = row => ({ id: row.id, trackingNumber: row.tracking_number, category: row.category, quantity: row.quantity,
  weightG: row.weight_g, status: row.status, originStopId: row.origin_stop_id, destinationStopId: row.destination_stop_id,
  originCity: row.origin_city, destinationCity: row.destination_city, pickupRequired: row.pickup_required, notes: row.notes });

async function trackingNumber(tx) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = 'LRP-' + randomBytes(4).toString('hex').toUpperCase();
    const conflict = await one(tx, 'SELECT id FROM parcels WHERE tracking_number=$1', [candidate]);
    if (!conflict) return candidate;
  }
  invariant(false, 'INTERNAL_ERROR', 'Could not allocate a tracking number.');
}

export function parcels(db) {
  async function addEvent(tx, { parcelId, kind, actor = null, principalId = null, serviceId = null, vehicleId = null, stopId = null, note = null, idempotencyKeyValue = null }) {
    const row = await one(tx, `INSERT INTO parcel_events(parcel_id,kind,actor_id,actor_role,principal_id,operator_id,service_id,vehicle_id,stop_id,note,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
    [parcelId, kind, actor?.id ?? null, actor?.role ?? null, principalId, actor?.operator_id ?? null, serviceId, vehicleId, stopId, note, idempotencyKeyValue]);
    return row;
  }
  async function transition(tx, parcel, target, actor, extra = {}) {
    invariant(TRANSITIONS[parcel.status].includes(target), 'INVALID_TRANSITION',
      `Cette expédition ne peut pas passer de ${parcel.status} à ${target}.`, 409);
    const next = await one(tx, 'UPDATE parcels SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [parcel.id, target]);
    await emit(tx, 'parcel.' + target, parcel.id, { trackingNumber: parcel.tracking_number, ...extra });
    return next;
  }
  async function authorize(tx, actor, parcelId) {
    const parcel = await one(tx, 'SELECT * FROM parcels WHERE id=$1 FOR UPDATE', [uuid(parcelId)]);
    invariant(parcel, 'NOT_FOUND', 'Parcel not found.', 404);
    if (actor?.role === 'passenger') {
      invariant(parcel.created_by === actor.id, 'FORBIDDEN', 'Cette expédition ne vous appartient pas.', 403);
      return parcel;
    }
    if (actor?.role === 'ops') {
      invariant(!actor.operator_id || actor.operator_id === parcel.operator_id, 'FORBIDDEN', 'Operation is not permitted.', 403);
      return parcel;
    }
    if (actor?.role === 'driver') {
      const assignment = await one(tx, `SELECT * FROM parcel_service_assignments WHERE parcel_id=$1 AND status IN ('assigned','loaded','in_transit','arrived') ORDER BY created_at DESC LIMIT 1`, [parcel.id]);
      invariant(assignment && assignment.driver_id === actor.id,
        'FORBIDDEN', 'Cette expédition n’est pas affectée à votre service.', 403);
      return parcel;
    }
    invariant(false, 'FORBIDDEN', 'Crew access required.', 403);
  }
  async function loadParties(tx, parcelId) {
    return (await tx.query('SELECT * FROM parcel_parties WHERE parcel_id=$1 ORDER BY role', [parcelId])).rows;
  }
  async function rateFor(tx, { operatorId, originStopId, destinationStopId, category, weightG = 0, declaredValueMinor = 0 }) {
    const rows = (await tx.query(`SELECT * FROM parcel_rate_rules WHERE operator_id=$1 AND active=true
      AND (origin_stop_id IS NULL OR origin_stop_id=$2) AND (destination_stop_id IS NULL OR destination_stop_id=$3)
      AND (category IS NULL OR category=$4)
      AND (min_weight_g IS NULL OR min_weight_g<=$5) AND (max_weight_g IS NULL OR max_weight_g>=$5)
      ORDER BY (origin_stop_id IS NOT NULL)::int DESC,(destination_stop_id IS NOT NULL)::int DESC,(category IS NOT NULL)::int DESC
      LIMIT 1`, [operatorId, originStopId, destinationStopId, category, weightG])).rows;
    const rule = rows[0];
    invariant(rule, 'PRICING_UNAVAILABLE', 'Aucune grille tarifaire n’est configurée pour ce trajet — aucun prix ne peut être inventé.', 503);
    const perKg = Math.ceil((weightG / 1000) * rule.per_kg_minor);
    const declared = Math.ceil((declaredValueMinor * rule.declared_value_bp) / 10000);
    return { ruleId: rule.id, amountMinor: rule.base_minor + perKg + declared, currency: 'XOF' };
  }
  async function findCarrier(tx, originStopId, destinationStopId, requestedOperatorId = null) {
    const rows = (await tx.query(`SELECT s.id,s.operator_id,o.name AS operator_name,
      (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$1) AS origin,
      (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$2) AS destination
      FROM services s JOIN operators o ON o.id=s.operator_id
      WHERE s.status IN ('scheduled','active') AND ($3::uuid IS NULL OR s.operator_id=$3)
      ORDER BY s.departure_at LIMIT 20`, [originStopId, destinationStopId, requestedOperatorId])).rows;
    for (const service of rows) {
      if (service.origin !== null && service.destination !== null && service.origin < service.destination) return service;
    }
    invariant(false, 'INVALID_JOURNEY', 'Aucun service actif ne relie ces deux points dans l’ordre demandé.', 409);
  }

  return {
    // --- pricing / quotes ---
    async quote(actor, input) {
      const q = input;
      invariant(q && Object.keys(q).every(k => ['originStopId', 'destinationStopId', 'category', 'weightG', 'declaredValueMinor', 'operatorId'].includes(k)),
        'INVALID_QUOTE', 'Unexpected quote fields.');
      uuid(q.originStopId); uuid(q.destinationStopId);
      invariant(typeof q.category === 'string' && q.category.length <= 40 && Number.isInteger(q.weightG ?? 0) && Number.isInteger(q.declaredValueMinor ?? 0),
        'INVALID_QUOTE', 'Quote fields are invalid.');
      return db.transaction(async tx => {
        const carrier = await findCarrier(tx, q.originStopId, q.destinationStopId, q.operatorId ?? (actor?.role === 'ops' ? actor.operator_id : null));
        const rate = await rateFor(tx, { operatorId: carrier.operator_id, originStopId: q.originStopId, destinationStopId: q.destinationStopId, category: q.category, weightG: q.weightG ?? 0, declaredValueMinor: q.declaredValueMinor ?? 0 });
        return { ...rate, operatorId: carrier.operator_id, operatorName: carrier.operator_name };
      });
    },
    async create(actor, input, key) {
      invariant(actor?.role === 'passenger' || actor?.role === 'ops', 'FORBIDDEN', 'Passenger or Ops access required.', 403);
      idempotencyKey(key);
      invariant(input && Object.keys(input).every(k => ['senderName', 'senderPhone', 'receiverName', 'receiverPhone', 'originStopId', 'destinationStopId',
        'category', 'quantity', 'weightG', 'dimensions', 'declaredValueMinor', 'notes', 'paymentResponsibility', 'operatorId', 'consignmentPointId', 'pickupPointId'].includes(k)),
      'INVALID_PARCEL', 'Unexpected parcel fields.');
      if (input.consignmentPointId) uuid(input.consignmentPointId);
      if (input.pickupPointId) uuid(input.pickupPointId);
      const party = (name, phone) => {
        invariant(typeof name === 'string' && name.trim().length >= 2 && name.length <= 100, 'INVALID_PARCEL', 'Sender and receiver names are required.');
        invariant(typeof phone === 'string' && /^\+?[0-9 ()-]{6,25}$/.test(phone), 'INVALID_PARCEL', 'A valid sender/receiver phone is required.');
        return { name: name.trim(), phone: phone.trim() };
      };
      const sender = party(input.senderName, input.senderPhone);
      const receiver = party(input.receiverName, input.receiverPhone);
      uuid(input.originStopId); uuid(input.destinationStopId);
      invariant(input.originStopId !== input.destinationStopId, 'INVALID_PARCEL', 'Origin and destination must differ.');
      invariant(typeof input.category === 'string' && /^[a-z0-9_]{1,40}$/.test(input.category), 'INVALID_PARCEL', 'Category is invalid.');
      const quantity = input.quantity ?? 1;
      invariant(Number.isInteger(quantity) && quantity >= 1 && quantity <= 100, 'INVALID_PARCEL', 'Quantity must be between 1 and 100.');
      const weightG = input.weightG ?? null;
      invariant(weightG === null || (Number.isInteger(weightG) && weightG >= 1 && weightG <= 500000), 'INVALID_PARCEL', 'Weight is invalid.');
      const declaredValue = input.declaredValueMinor ?? null;
      invariant(declaredValue === null || (Number.isInteger(declaredValue) && declaredValue >= 0), 'INVALID_PARCEL', 'Declared value is invalid.');
      const responsibility = input.paymentResponsibility ?? 'sender';
      invariant(['sender', 'receiver', 'cash'].includes(responsibility), 'INVALID_PARCEL', 'Payment responsibility is invalid.');
      if (actor?.role === 'ops' && actor.operator_id && input.operatorId) invariant(actor.operator_id === input.operatorId, 'FORBIDDEN', 'Operation is not permitted.', 403);
      const notes = input.notes === undefined || input.notes === null ? null : String(input.notes);
      invariant(notes === null || notes.length <= 2000, 'INVALID_PARCEL', 'Notes are too long.');
      const dimensions = input.dimensions === undefined ? null : input.dimensions;
      invariant(dimensions === null || (dimensions && typeof dimensions === 'object' && !Array.isArray(dimensions) &&
        Object.keys(dimensions).every(k => ['lengthCm', 'widthCm', 'heightCm'].includes(k)) &&
        Object.values(dimensions).every(v => Number.isInteger(v) && v >= 0 && v <= 1000)), 'INVALID_PARCEL', 'Dimensions are invalid.');
      const fingerprint = digest([actor.id, input.originStopId, input.destinationStopId, input.category, quantity, weightG, declaredValue, notes]);
      return db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['parcel:' + actor.id + ':' + key]);
        const prior = await one(tx, 'SELECT * FROM parcels WHERE created_by=$1 AND idempotency_key=$2', [actor.id, key]);
        if (prior) { invariant(prior.request_fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Key was used for a different request.', 409); return publicParcel(prior, await loadParties(tx, prior.id)); }
        const category = await one(tx, 'SELECT * FROM parcel_categories WHERE name=$1', [input.category]);
        invariant(category && category.accepted, 'RESTRICTED_CATEGORY', 'Cette catégorie de colis n’est pas acceptée pour le moment.', 409);
        // Operational precision: parcel points reuse the canonical registry.
        if (input.consignmentPointId) {
          invariant(await one(tx, "SELECT id FROM boarding_points WHERE id=$1 AND status='verified' AND purposes @> '[\"parcel_consignment\"]'::jsonb", [input.consignmentPointId]),
            'INVALID_POINT', 'Point de remise colis invalide.', 409);
        }
        if (input.pickupPointId) {
          invariant(await one(tx, "SELECT id FROM boarding_points WHERE id=$1 AND status='verified' AND purposes @> '[\"parcel_pickup\"]'::jsonb", [input.pickupPointId]),
            'INVALID_POINT', 'Point de retrait colis invalide.', 409);
        }
        const carrier = await findCarrier(tx, input.originStopId, input.destinationStopId, actor?.role === 'ops' ? (input.operatorId ?? actor.operator_id) : input.operatorId ?? null);
        const rate = await rateFor(tx, { operatorId: carrier.operator_id, originStopId: input.originStopId, destinationStopId: input.destinationStopId, category: input.category, weightG: weightG ?? 0, declaredValueMinor: declaredValue ?? 0 });
        const number = await trackingNumber(tx);
        const row = await one(tx, `INSERT INTO parcels(tracking_number,operator_id,origin_stop_id,destination_stop_id,category,quantity,weight_g,dimensions,
          declared_value_minor,notes,payment_responsibility,price_minor,status,idempotency_key,request_fingerprint,created_by,eta_at,consignment_point_id,pickup_point_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'created',$13,$14,$15,NULL,$16,$17) RETURNING *`,
        [number, carrier.operator_id, input.originStopId, input.destinationStopId, input.category, quantity, weightG, dimensions === null ? null : JSON.stringify(dimensions),
          declaredValue, notes, responsibility, rate.amountMinor, key, fingerprint, actor.id, input.consignmentPointId ?? null, input.pickupPointId ?? null]);
        await tx.query('INSERT INTO parcel_parties(parcel_id,role,name,phone) VALUES($1,$2,$3,$4),($1,$5,$6,$7)',
          [row.id, 'sender', sender.name, sender.phone, 'receiver', receiver.name, receiver.phone]);
        await addEvent(tx, { parcelId: row.id, kind: 'created', actor, stopId: input.originStopId });
        await emit(tx, 'parcel.created', row.id, { trackingNumber: number, operatorId: row.operator_id });
        await audit(tx, actor.id, 'parcel.created', row.id, row.operator_id, { trackingNumber: number, priceMinor: rate.amountMinor });
        return publicParcel(row, [{ role: 'sender', ...sender }, { role: 'receiver', ...receiver }]);
      });
    },
    async listMine(actor) {
      invariant(actor?.role === 'passenger', 'FORBIDDEN', 'Passenger access required.', 403);
      return db.transaction(async tx => (await tx.query('SELECT * FROM parcels WHERE created_by=$1 ORDER BY created_at DESC LIMIT 100', [actor.id])).rows.map(r => publicParcel(r)));
    },
    async listOps(actor, filter = {}) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      invariant(filter.status === undefined || STATUSES.includes(filter.status), 'INVALID_STATUS', 'Invalid parcel status.');
      invariant(filter.q === undefined || typeof filter.q === 'string', 'INVALID_QUERY', 'Invalid search query.');
      return db.transaction(async tx => (await tx.query(`SELECT p.* FROM parcels p
        WHERE ($1::text IS NULL OR p.status=$1) AND ($2::text IS NULL OR p.tracking_number ILIKE '%'||$2||'%')
        AND ($3::uuid IS NULL OR p.operator_id=$3) ORDER BY p.created_at DESC LIMIT 100`,
      [filter.status ?? null, (filter.q ?? '').slice(0, 40) || null, actor.operator_id])).rows.map(r => publicParcel(r)));
    },
    async listDriver(actor) {
      invariant(actor?.role === 'driver', 'FORBIDDEN', 'Driver access required.', 403);
      return db.transaction(async tx => {
        const service = await one(tx, `SELECT s.id FROM service_assignments a JOIN services s ON s.id=a.service_id
          WHERE a.driver_id=$1 AND a.ended_at IS NULL AND s.status IN ('scheduled','active','disrupted') ORDER BY s.departure_at LIMIT 1`, [actor.id]);
        if (!service) return [];
        return (await tx.query(`SELECT p.*,o.name AS origin_city,d.name AS destination_city FROM parcels p
          JOIN parcel_service_assignments a ON a.parcel_id=p.id AND a.status IN ('assigned','loaded','in_transit','arrived')
          JOIN stops o ON o.id=p.origin_stop_id JOIN stops d ON d.id=p.destination_stop_id
          WHERE a.service_id=$1 ORDER BY p.created_at LIMIT 100`, [service.id])).rows
          .map(r => driverParcel({ ...r, pickup_required: r.status === 'ready_for_pickup' }));
      });
    },
    async get(actor, id) {
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        if (actor?.role === 'driver') return driverParcel({ ...parcel, pickup_required: parcel.status === 'ready_for_pickup' });
        return publicParcel(parcel, await loadParties(tx, parcel.id));
      });
    },
    async events(actor, id) {
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        const rows = (await tx.query('SELECT * FROM parcel_events WHERE parcel_id=$1 ORDER BY created_at', [parcel.id])).rows;
        return rows.map(e => ({ kind: e.kind, actorRole: e.actor_role, serviceId: e.service_id, vehicleId: e.vehicle_id,
          stopId: e.stop_id, createdAt: e.created_at, note: actor?.role === 'passenger' ? null : e.note }));
      });
    },
    async label(actor, id) {
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        const token = 'LRP1.' + randomBytes(32).toString('base64url');
        const row = await one(tx, `INSERT INTO parcel_labels(parcel_id,version,token_hash) VALUES($1,1,$2)
          ON CONFLICT(parcel_id) DO UPDATE SET version=parcel_labels.version+1,token_hash=EXCLUDED.token_hash,issued_at=now()
          RETURNING version`, [parcel.id, hash(token)]);
        return { trackingNumber: parcel.tracking_number, token, barcode: parcel.tracking_number, version: row.version };
      });
    },
    async accept(actor, id) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        const next = await transition(tx, parcel, 'accepted', actor);
        await tx.query(`INSERT INTO parcel_custody(parcel_id,holder_kind,operator_id,stop_id) VALUES($1,'station',$2,$3)
          ON CONFLICT(parcel_id) DO UPDATE SET holder_kind='station',operator_id=$2,stop_id=$3,driver_id=NULL,service_id=NULL,since=now()`,
        [parcel.id, parcel.operator_id, parcel.origin_stop_id]);
        await addEvent(tx, { parcelId: parcel.id, kind: 'accepted', actor, stopId: parcel.origin_stop_id });
        await audit(tx, actor.id, 'parcel.accepted', parcel.id, parcel.operator_id);
        return publicParcel(next);
      });
    },
    async assign(actor, id, input) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      invariant(input && Object.keys(input).every(k => ['serviceId'].includes(k)), 'INVALID_ASSIGNMENT', 'Unexpected assignment fields.');
      uuid(input.serviceId);
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        invariant(parcel.status === 'accepted', 'INVALID_TRANSITION', 'Accept the parcel before assigning it to a service.', 409);
        const service = await one(tx, 'SELECT * FROM services WHERE id=$1', [input.serviceId]);
        invariant(service && service.operator_id === parcel.operator_id, 'INVALID_SERVICE', 'Service belongs to another operator.', 409);
        invariant(['scheduled', 'active'].includes(service.status) && (service.status === 'active' || new Date(service.departure_at) > new Date()),
          'SERVICE_UNAVAILABLE', 'Service is no longer open for loading.', 409);
        const from = await one(tx, 'SELECT sequence FROM service_stops WHERE service_id=$1 AND stop_id=$2', [service.id, parcel.origin_stop_id]);
        const to = await one(tx, 'SELECT sequence FROM service_stops WHERE service_id=$1 AND stop_id=$2', [service.id, parcel.destination_stop_id]);
        invariant(from && to && from.sequence < to.sequence, 'INVALID_SERVICE', 'The service does not cover origin before destination.', 409);
        const assignment = await one(tx, `SELECT vehicle_id,driver_id FROM service_assignments WHERE service_id=$1 AND ended_at IS NULL`, [service.id]);
        invariant(assignment, 'INVALID_ASSIGNMENT', 'The service has no current vehicle assignment.', 409);
        await one(tx, `INSERT INTO parcel_service_assignments(parcel_id,service_id,vehicle_id,driver_id,from_stop_id,to_stop_id,assigned_by)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [parcel.id, service.id, assignment.vehicle_id, assignment.driver_id, parcel.origin_stop_id, parcel.destination_stop_id, actor.id]);
        const next = await transition(tx, parcel, 'manifested', actor, { serviceId: service.id });
        await addEvent(tx, { parcelId: parcel.id, kind: 'manifested', actor, serviceId: service.id, vehicleId: assignment.vehicle_id, stopId: parcel.origin_stop_id });
        await audit(tx, actor.id, 'parcel.manifested', parcel.id, parcel.operator_id, { serviceId: service.id });
        return publicParcel(next);
      });
    },
    async scan(actor, id, input, key) {
      idempotencyKey(key);
      invariant(input && Object.keys(input).every(k => ['kind'].includes(k)) && ['loaded', 'departed', 'arrived'].includes(input.kind),
        'INVALID_SCAN', 'Scan kind must be loaded, departed or arrived.');
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        // Offline replays are idempotent: a scan already recorded under the
        // same key returns the current state without re-applying transitions.
        const prior = await one(tx, 'SELECT id FROM parcel_events WHERE parcel_id=$1 AND kind=$2 AND idempotency_key=$3', [parcel.id, input.kind, key]);
        if (prior) return publicParcel(parcel);
        const assignment = await one(tx, `SELECT * FROM parcel_service_assignments WHERE parcel_id=$1 AND status IN ('assigned','loaded','in_transit','arrived') ORDER BY created_at DESC LIMIT 1`, [parcel.id]);
        invariant(assignment, 'INVALID_ASSIGNMENT', 'Assign the parcel to a service before scanning.', 409);
        if (input.kind === 'loaded') {
          invariant(parcel.status === 'manifested', 'INVALID_TRANSITION', 'This parcel is already loaded or no longer loadable.', 409);
          await one(tx, 'UPDATE parcel_service_assignments SET status=$2 WHERE id=$1', [assignment.id, 'loaded']);
          const next = await transition(tx, parcel, 'loaded', actor, { serviceId: assignment.service_id });
          await tx.query(`UPDATE parcel_custody SET holder_kind='driver',driver_id=$2,service_id=$3,operator_id=$4,stop_id=$5,since=now() WHERE parcel_id=$1`,
            [parcel.id, assignment.driver_id, assignment.service_id, parcel.operator_id, parcel.origin_stop_id]);
          await addEvent(tx, { parcelId: parcel.id, kind: 'loaded', actor, serviceId: assignment.service_id, vehicleId: assignment.vehicle_id, stopId: parcel.origin_stop_id, idempotencyKeyValue: key });
          await audit(tx, actor.id, 'parcel.loaded', parcel.id, parcel.operator_id, { serviceId: assignment.service_id });
          return publicParcel(next);
        }
        if (input.kind === 'departed') {
          invariant(parcel.status === 'loaded', 'INVALID_TRANSITION', 'The parcel must be loaded before departure.', 409);
          await one(tx, 'UPDATE parcel_service_assignments SET status=$2 WHERE id=$1', [assignment.id, 'in_transit']);
          const next = await transition(tx, parcel, 'in_transit', actor, { serviceId: assignment.service_id });
          await addEvent(tx, { parcelId: parcel.id, kind: 'departed', actor, serviceId: assignment.service_id, vehicleId: assignment.vehicle_id, stopId: parcel.origin_stop_id, idempotencyKeyValue: key });
          await audit(tx, actor.id, 'parcel.departed', parcel.id, parcel.operator_id, { serviceId: assignment.service_id });
          return publicParcel(next);
        }
        invariant(parcel.status === 'in_transit', 'INVALID_TRANSITION', 'The parcel must be in transit before arrival.', 409);
        await one(tx, 'UPDATE parcel_service_assignments SET status=$2 WHERE id=$1', [assignment.id, 'arrived']);
        const next = await transition(tx, parcel, 'arrived', actor, { serviceId: assignment.service_id });
        await tx.query(`UPDATE parcel_custody SET holder_kind='station',operator_id=$2,stop_id=$3,driver_id=NULL,service_id=NULL,since=now() WHERE parcel_id=$1`,
          [parcel.id, parcel.operator_id, parcel.destination_stop_id]);
        await addEvent(tx, { parcelId: parcel.id, kind: 'arrived', actor, serviceId: assignment.service_id, vehicleId: assignment.vehicle_id, stopId: parcel.destination_stop_id, idempotencyKeyValue: key });
        await audit(tx, actor.id, 'parcel.arrived', parcel.id, parcel.operator_id, { serviceId: assignment.service_id });
        return publicParcel(next);
      });
    },
    async ready(actor, id) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        const next = await transition(tx, parcel, 'ready_for_pickup', actor);
        await addEvent(tx, { parcelId: parcel.id, kind: 'ready_for_pickup', actor, stopId: parcel.destination_stop_id });
        await audit(tx, actor.id, 'parcel.ready', parcel.id, parcel.operator_id);
        return publicParcel(next);
      });
    },
    async issuePickupCode(actor, id) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      const code = String(Math.floor(100000 + (Number(randomBytes(4).readUInt32BE(0)) % 900000)));
      const expires = new Date(Date.now() + 15 * 60 * 1000);
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        invariant(parcel.status === 'ready_for_pickup', 'INVALID_TRANSITION', 'The parcel must be ready for pickup first.', 409);
        // Supersede any previously issued, unused code.
        await tx.query("UPDATE parcel_pickup_codes SET used_at=now() WHERE parcel_id=$1 AND used_at IS NULL", [parcel.id]);
        await one(tx, 'INSERT INTO parcel_pickup_codes(parcel_id,code_hash,expires_at) VALUES($1,$2,$3)', [parcel.id, hash(code), expires]);
        await addEvent(tx, { parcelId: parcel.id, kind: 'pickup_code_issued', actor, stopId: parcel.destination_stop_id });
        await emit(tx, 'parcel.pickup_code_issued', parcel.id, { trackingNumber: parcel.tracking_number });
        await audit(tx, actor.id, 'parcel.pickup_code_issued', parcel.id, parcel.operator_id);
        return { trackingNumber: parcel.tracking_number, code, expiresAt: expires };
      });
    },
    async collect(actor, id, input) {
      invariant(actor?.role === 'ops' || actor?.role === 'driver', 'FORBIDDEN', 'Station or driver access required.', 403);
      invariant(input && Object.keys(input).every(k => ['code', 'receiverName', 'signatureRef', 'imageRef', 'labelToken'].includes(k)),
        'INVALID_PICKUP', 'Unexpected pickup fields.');
      invariant(typeof input.code === 'string' && /^\d{6}$/.test(input.code), 'INVALID_PICKUP', 'A valid 6-digit pickup code is required.');
      const receiverName = input.receiverName === undefined || input.receiverName === null ? null : String(input.receiverName);
      invariant(receiverName === null || (receiverName.trim().length >= 2 && receiverName.length <= 100), 'INVALID_PICKUP', 'Receiver name is invalid.');
      const labelToken = input.labelToken === undefined || input.labelToken === null ? null : String(input.labelToken);
      invariant(labelToken === null || (labelToken.length > 0 && labelToken.length <= 200), 'INVALID_PICKUP', 'Label token is invalid.');
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        invariant(parcel.status === 'ready_for_pickup', 'INVALID_TRANSITION', 'The parcel is not ready for pickup.', 409);
        if (labelToken) {
          const label = await one(tx, 'SELECT token_hash FROM parcel_labels WHERE parcel_id=$1', [parcel.id]);
          invariant(label && label.token_hash === hash(labelToken), 'INVALID_PICKUP', 'QR du colis invalide.', 403);
        }
        const active = await one(tx, 'SELECT * FROM parcel_pickup_codes WHERE parcel_id=$1 AND used_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [parcel.id]);
        invariant(active && active.code_hash === hash(input.code), 'INVALID_PICKUP', 'Code de retrait invalide ou expiré.', 403);
        await one(tx, 'UPDATE parcel_pickup_codes SET used_at=now() WHERE id=$1', [active.id]);
        const next = await transition(tx, parcel, 'collected', actor);
        await tx.query(`UPDATE parcel_custody SET holder_kind='receiver',operator_id=$2,stop_id=$3,driver_id=NULL,service_id=NULL,since=now() WHERE parcel_id=$1`,
          [parcel.id, parcel.operator_id, parcel.destination_stop_id]);
        await one(tx, `INSERT INTO parcel_proof_of_delivery(parcel_id,receiver_name,collected_at,stop_id,released_by,signature_ref,image_ref)
          VALUES($1,$2,now(),$3,$4,$5,$6)`,
        [parcel.id, receiverName, parcel.destination_stop_id, actor.id, input.signatureRef ?? null, input.imageRef ?? null]);
        await addEvent(tx, { parcelId: parcel.id, kind: 'collected', actor, stopId: parcel.destination_stop_id, note: receiverName });
        await audit(tx, actor.id, 'parcel.collected', parcel.id, parcel.operator_id, { receiverName });
        return publicParcel(next);
      });
    },
    async exception(actor, id, input) {
      invariant(actor?.role === 'ops' || actor?.role === 'driver', 'FORBIDDEN', 'Crew access required.', 403);
      invariant(input && Object.keys(input).every(k => ['kind', 'description'].includes(k)), 'INVALID_EXCEPTION', 'Unexpected exception fields.');
      invariant(['damaged', 'lost', 'rejected', 'held', 'return_requested', 'other'].includes(input.kind) &&
        typeof input.description === 'string' && input.description.trim().length > 0 && input.description.length <= 2000,
      'INVALID_EXCEPTION', 'Exception details are invalid.');
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        const row = await one(tx, 'INSERT INTO parcel_exceptions(parcel_id,kind,description,reported_by) VALUES($1,$2,$3,$4) RETURNING *',
          [parcel.id, input.kind, input.description.trim(), actor.id]);
        await addEvent(tx, { parcelId: parcel.id, kind: 'exception', actor, note: input.kind + ': ' + input.description.trim() });
        await emit(tx, 'parcel.exception', parcel.id, { trackingNumber: parcel.tracking_number, kind: input.kind, parcelId: parcel.id });
        await audit(tx, actor.id, 'parcel.exception', parcel.id, parcel.operator_id, { kind: input.kind, exceptionId: row.id });
        const target = EXCEPTION_STATUS[input.kind];
        if (!target) return publicParcel(parcel);
        const next = await transition(tx, parcel, target, actor, { kind: input.kind });
        if (target === 'held') {
          await tx.query(`UPDATE parcel_custody SET holder_kind='station',operator_id=$2,stop_id=$3,driver_id=NULL,service_id=NULL,since=now() WHERE parcel_id=$1`,
            [parcel.id, parcel.operator_id, parcel.destination_stop_id]);
        }
        return publicParcel(next);
      });
    },
    async cancel(actor, id) {
      return db.transaction(async tx => {
        const parcel = await authorize(tx, actor, id);
        invariant(['created', 'accepted', 'manifested'].includes(parcel.status), 'INVALID_TRANSITION', 'Only unloaded parcels can be cancelled.', 409);
        const next = await transition(tx, parcel, 'cancelled', actor);
        await tx.query(`UPDATE parcel_service_assignments SET status='cancelled',ended_at=now() WHERE parcel_id=$1 AND status IN ('assigned','loaded','in_transit','arrived')`, [parcel.id]);
        await tx.query('DELETE FROM parcel_custody WHERE parcel_id=$1', [parcel.id]);
        await addEvent(tx, { parcelId: parcel.id, kind: 'cancelled', actor });
        await audit(tx, actor.id, 'parcel.cancelled', parcel.id, parcel.operator_id);
        return publicParcel(next);
      });
    },
    async recordPayment(actor, id, input, key) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      idempotencyKey(key);
      invariant(input && Object.keys(input).every(k => ['provider', 'reference', 'amountMinor'].includes(k)),
        'INVALID_PAYMENT', 'Unexpected payment fields.');
      invariant(['cash', 'bank_transfer'].includes(input.provider) && typeof input.reference === 'string' && input.reference.length > 0 && input.reference.length <= 100 &&
        Number.isInteger(input.amountMinor) && input.amountMinor >= 0, 'INVALID_PAYMENT', 'Payment record is invalid.');
      const fingerprint = digest([id, input.amountMinor, input.provider, input.reference]);
      const storedKey = 'parcel-payment:' + actor.id + ':' + key;
      return db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [storedKey]);
        const parcel = await authorize(tx, actor, id);
        const prior = await one(tx, 'SELECT * FROM parcel_payments WHERE idempotency_key=$1', [storedKey]);
        if (prior) { invariant(prior.request_fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Key was used for another payment.', 409); return prior; }
        invariant(input.amountMinor === parcel.price_minor, 'INVALID_PAYMENT', 'Payment does not match the parcel price.', 409);
        const row = await one(tx, `INSERT INTO parcel_payments(parcel_id,provider,provider_reference,amount_minor,currency,status,responsibility,idempotency_key,request_fingerprint,recorded_by)
          VALUES($1,$2,$3,$4,'XOF','succeeded',$5,$6,$7,$8) RETURNING *`,
        [parcel.id, input.provider, input.reference, input.amountMinor, parcel.payment_responsibility, storedKey, fingerprint, actor.id]);
        await emit(tx, 'parcel.payment_recorded', parcel.id, { trackingNumber: parcel.tracking_number, amountMinor: input.amountMinor });
        await audit(tx, actor.id, 'parcel.payment_recorded', parcel.id, parcel.operator_id, { amountMinor: input.amountMinor, provider: input.provider });
        return { id: row.id, parcelId: parcel.id, provider: row.provider, status: row.status, amountMinor: row.amount_minor, currency: row.currency };
      });
    },
    async reconcilePayment(actor, input) {
      invariant(input && Object.keys(input).every(k => ['parcelPaymentId'].includes(k)), 'INVALID_PAYMENT', 'Unexpected reconcile fields.');
      uuid(input.parcelPaymentId);
      return db.transaction(async tx => {
        const payment = await one(tx, 'SELECT * FROM parcel_payments WHERE id=$1 FOR UPDATE', [input.parcelPaymentId]);
        invariant(payment, 'NOT_FOUND', 'Parcel payment not found.', 404);
        const parcel = await one(tx, 'SELECT * FROM parcels WHERE id=$1', [payment.parcel_id]);
        if (actor?.agent?.operatorId) invariant(parcel.operator_id === actor.agent.operatorId, 'FORBIDDEN', 'Operation is not permitted.', 403);
        if (actor?.role === 'ops') invariant(!actor.operator_id || actor.operator_id === parcel.operator_id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        invariant(payment.amount_minor === parcel.price_minor, 'PAYMENT_MISMATCH', 'Payment does not match the parcel price.', 409);
        invariant(['pending', 'succeeded'].includes(payment.status), 'PAYMENT_TRANSITION', 'Payment cannot be reconciled from its current state.', 409);
        const row = await one(tx, 'UPDATE parcel_payments SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [payment.id, 'succeeded']);
        await audit(tx, actor?.id ?? null, 'parcel.payment_reconciled', parcel.id, parcel.operator_id, { parcelPaymentId: payment.id });
        return { id: row.id, parcelId: parcel.id, status: row.status, amountMinor: row.amount_minor };
      });
    },
    async updateEta(actor, input) {
      invariant(input && Object.keys(input).every(k => ['parcelId', 'etaAt'].includes(k)), 'INVALID_ETA', 'Unexpected ETA fields.');
      uuid(input.parcelId);
      const eta = new Date(input.etaAt);
      invariant(Number.isFinite(eta.getTime()), 'INVALID_ETA', 'ETA is invalid.');
      return db.transaction(async tx => {
        const parcel = await one(tx, 'SELECT * FROM parcels WHERE id=$1 FOR UPDATE', [input.parcelId]);
        invariant(parcel, 'NOT_FOUND', 'Parcel not found.', 404);
        if (actor?.agent?.operatorId) invariant(parcel.operator_id === actor.agent.operatorId, 'FORBIDDEN', 'Operation is not permitted.', 403);
        const row = await one(tx, 'UPDATE parcels SET eta_at=$2,updated_at=now() WHERE id=$1 RETURNING *', [parcel.id, eta]);
        await addEvent(tx, { parcelId: parcel.id, kind: 'eta_updated', principalId: actor?.agent?.id ?? null, note: eta.toISOString() });
        await emit(tx, 'parcel.eta_updated', parcel.id, { trackingNumber: parcel.tracking_number, etaAt: eta.toISOString() });
        await audit(tx, null, 'parcel.eta_updated', parcel.id, parcel.operator_id, { etaAt: eta.toISOString() });
        return publicParcel(row);
      });
    },
    // Public tracking: safe fields only, never parties, phones or payment data.
    async publicTracking(trackingNumberValue) {
      invariant(typeof trackingNumberValue === 'string' && /^LRP-[0-9A-F]{8}$/i.test(trackingNumberValue.trim()), 'NOT_FOUND', 'Tracking number not found.', 404);
      return db.transaction(async tx => {
        const row = await one(tx, `SELECT p.*,op.name AS origin_city,dp.name AS destination_city,
          cbp.name AS consignment_name,cpp.name AS pickup_name,
          cbp.description AS consignment_landmark,cpp.description AS pickup_landmark
          FROM parcels p JOIN stops o ON o.id=p.origin_stop_id JOIN stops d ON d.id=p.destination_stop_id
          JOIN places op ON op.id=o.place_id JOIN places dp ON dp.id=d.place_id
          LEFT JOIN boarding_points cbp ON cbp.id=p.consignment_point_id LEFT JOIN boarding_points cpp ON cpp.id=p.pickup_point_id
          WHERE p.tracking_number=$1`, [trackingNumberValue.trim().toUpperCase()]);
        invariant(row, 'NOT_FOUND', 'Tracking number not found.', 404);
        const last = await one(tx, 'SELECT * FROM parcel_events WHERE parcel_id=$1 ORDER BY created_at DESC LIMIT 1', [row.id]);
        const custody = await one(tx, 'SELECT * FROM parcel_custody WHERE parcel_id=$1', [row.id]);
        let location = null;
        if (['loaded', 'in_transit'].includes(row.status) && custody?.service_id) {
          const position = await one(tx, 'SELECT latitude,longitude,observed_at FROM vehicle_positions WHERE service_id=$1 ORDER BY observed_at DESC LIMIT 1', [custody.service_id]);
          if (position) location = { latitude: position.latitude, longitude: position.longitude, observedAt: position.observed_at, derivedFromVehicle: true };
        }
        return {
          trackingNumber: row.tracking_number,
          status: row.status,
          origin: { city: row.origin_city },
          destination: { city: row.destination_city },
          consignmentPoint: row.consignment_name ? { name: row.consignment_name, landmark: row.consignment_landmark, city: row.origin_city } : null,
          pickupPoint: row.pickup_name ? { name: row.pickup_name, landmark: row.pickup_landmark, city: row.destination_city } : null,
          lastMilestone: last ? { kind: last.kind, at: last.created_at } : null,
          pickupReady: row.status === 'ready_for_pickup',
          eta: row.eta_at,
          location,
          updatedAt: row.updated_at,
        };
      });
    },
    // Reassign to a replacement service (agentic recovery): closes the active
    // assignment and opens a new one for the remaining journey. Ops approval
    // is enforced by the workflow gate, never inside this service.
    async reassign(actor, input) {
      invariant(input && Object.keys(input).every(k => ['parcelId', 'serviceId'].includes(k)), 'INVALID_ASSIGNMENT', 'Unexpected reassignment fields.');
      uuid(input.parcelId); uuid(input.serviceId);
      return db.transaction(async tx => {
        const parcel = await one(tx, 'SELECT * FROM parcels WHERE id=$1 FOR UPDATE', [input.parcelId]);
        invariant(parcel, 'NOT_FOUND', 'Parcel not found.', 404);
        if (actor?.agent?.operatorId) invariant(parcel.operator_id === actor.agent.operatorId, 'FORBIDDEN', 'Operation is not permitted.', 403);
        if (actor?.role === 'ops') invariant(!actor.operator_id || actor.operator_id === parcel.operator_id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        invariant(['loaded', 'in_transit', 'held'].includes(parcel.status), 'INVALID_TRANSITION', 'Only loaded or in-transit parcels can be reassigned.', 409);
        const current = await one(tx, `SELECT * FROM parcel_service_assignments WHERE parcel_id=$1 AND status IN ('assigned','loaded','in_transit','arrived') ORDER BY created_at DESC LIMIT 1`, [parcel.id]);
        invariant(current, 'INVALID_ASSIGNMENT', 'No active assignment exists.', 409);
        const service = await one(tx, 'SELECT * FROM services WHERE id=$1', [input.serviceId]);
        invariant(service && service.operator_id === parcel.operator_id, 'INVALID_SERVICE', 'Service belongs to another operator.', 409);
        invariant(['scheduled', 'active', 'disrupted'].includes(service.status), 'SERVICE_UNAVAILABLE', 'Replacement service is not available.', 409);
        const from = await one(tx, 'SELECT sequence FROM service_stops WHERE service_id=$1 AND stop_id=$2', [service.id, parcel.origin_stop_id]);
        const to = await one(tx, 'SELECT sequence FROM service_stops WHERE service_id=$1 AND stop_id=$2', [service.id, parcel.destination_stop_id]);
        invariant(from && to && from.sequence < to.sequence, 'INVALID_SERVICE', 'The replacement service does not cover the journey.', 409);
        const assignment = await one(tx, 'SELECT vehicle_id,driver_id FROM service_assignments WHERE service_id=$1 AND ended_at IS NULL', [service.id]);
        invariant(assignment, 'INVALID_ASSIGNMENT', 'The replacement service has no current assignment.', 409);
        await one(tx, 'UPDATE parcel_service_assignments SET status=$2,ended_at=now() WHERE id=$1', [current.id, 'offloaded']);
        await one(tx, `INSERT INTO parcel_service_assignments(parcel_id,service_id,vehicle_id,driver_id,from_stop_id,to_stop_id,assigned_by)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [parcel.id, service.id, assignment.vehicle_id, assignment.driver_id, parcel.origin_stop_id, parcel.destination_stop_id, actor?.id ?? assignment.driver_id]);
        await tx.query('UPDATE parcel_custody SET service_id=$2,driver_id=$3,since=now() WHERE parcel_id=$1',
          [parcel.id, service.id, assignment.driver_id]);
        await addEvent(tx, { parcelId: parcel.id, kind: 'reassigned', actor, principalId: actor?.agent?.id ?? null, serviceId: service.id, vehicleId: assignment.vehicle_id, note: 'from ' + current.service_id });
        await emit(tx, 'parcel.reassigned', parcel.id, { trackingNumber: parcel.tracking_number, serviceId: service.id });
        await audit(tx, actor?.id ?? null, 'parcel.reassigned', parcel.id, parcel.operator_id, { serviceId: service.id, previousServiceId: current.service_id });
        return publicParcel(await one(tx, 'SELECT * FROM parcels WHERE id=$1', [parcel.id]));
      });
    },
    async markDelayed(actor, input) {
      invariant(input && Object.keys(input).every(k => ['parcelId', 'reason'].includes(k)), 'INVALID_DELAY', 'Unexpected delay fields.');
      uuid(input.parcelId);
      invariant(typeof input.reason === 'string' && input.reason.length > 0 && input.reason.length <= 300, 'INVALID_DELAY', 'Reason is required.');
      return db.transaction(async tx => {
        const parcel = await one(tx, 'SELECT * FROM parcels WHERE id=$1 FOR UPDATE', [input.parcelId]);
        invariant(parcel, 'NOT_FOUND', 'Parcel not found.', 404);
        if (actor?.agent?.operatorId) invariant(parcel.operator_id === actor.agent.operatorId, 'FORBIDDEN', 'Operation is not permitted.', 403);
        invariant(['loaded', 'in_transit', 'held'].includes(parcel.status), 'INVALID_TRANSITION', 'Only loaded or in-transit parcels can be delayed.', 409);
        await addEvent(tx, { parcelId: parcel.id, kind: 'delayed', principalId: actor?.agent?.id ?? null, note: input.reason });
        await emit(tx, 'parcel.delayed', parcel.id, { trackingNumber: parcel.tracking_number, reason: input.reason });
        await audit(tx, actor?.id ?? null, 'parcel.delayed', parcel.id, parcel.operator_id, { reason: input.reason });
        return publicParcel(parcel);
      });
    },
    async rateRules(actor, input = undefined, key = undefined) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      if (input === undefined) {
        return db.transaction(async tx => (await tx.query('SELECT * FROM parcel_rate_rules WHERE ($1::uuid IS NULL OR operator_id=$1) ORDER BY created_at', [actor.operator_id])).rows);
      }
      idempotencyKey(key);
      invariant(input && Object.keys(input).every(k => ['operatorId', 'originStopId', 'destinationStopId', 'category', 'minWeightG', 'maxWeightG', 'baseMinor', 'perKgMinor', 'declaredValueBp'].includes(k)),
        'INVALID_RULE', 'Unexpected rule fields.');
      const operatorId = input.operatorId ?? actor.operator_id;
      invariant(operatorId, 'INVALID_RULE', 'Operator is required.');
      uuid(operatorId);
      if (input.originStopId) uuid(input.originStopId);
      if (input.destinationStopId) uuid(input.destinationStopId);
      invariant(Number.isInteger(input.baseMinor) && input.baseMinor >= 0 &&
        Number.isInteger(input.perKgMinor ?? 0) && (input.perKgMinor ?? 0) >= 0 &&
        Number.isInteger(input.declaredValueBp ?? 0) && (input.declaredValueBp ?? 0) >= 0, 'INVALID_RULE', 'Rule amounts are invalid.');
      return db.transaction(async tx => {
        invariant(!actor.operator_id || actor.operator_id === operatorId, 'FORBIDDEN', 'Operation is not permitted.', 403);
        const row = await one(tx, `INSERT INTO parcel_rate_rules(operator_id,origin_stop_id,destination_stop_id,category,min_weight_g,max_weight_g,base_minor,per_kg_minor,declared_value_bp)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [operatorId, input.originStopId ?? null, input.destinationStopId ?? null, input.category ?? null,
          input.minWeightG ?? null, input.maxWeightG ?? null, input.baseMinor, input.perKgMinor ?? 0, input.declaredValueBp ?? 0]);
        await audit(tx, actor.id, 'parcel.rate_rule_created', row.id, operatorId);
        return row;
      });
    },
  };
}
