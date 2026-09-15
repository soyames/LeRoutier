import { invariant, uuid } from '@leroutier/domain';

// Typed, structured agent actions. Every action declares: name, category
// (read | low_risk | privileged | financial), required principal scope,
// whether human approval is required, input validation and an idempotent,
// audited runner. Financial/high-impact actions never run without approval
// unless a documented pre-approved policy exists.
export const CATEGORIES = ['read', 'low_risk', 'privileged', 'financial'];

// Optional fields are marked so schemas stay strict on unknown fields while
// allowing callers to omit keys they do not use.
const optional = fn => Object.assign((value) => value === undefined || value === null || fn(value), { optional: true });
const validate = (shape, input) => {
  invariant((input === undefined || (input && typeof input === 'object' && !Array.isArray(input))) &&
    (input === undefined || Object.keys(input).every(k => Object.hasOwn(shape, k))),
  'INVALID_ACTION_INPUT', 'Action input does not match its schema.');
  for (const [key, check] of Object.entries(shape)) {
    if (input === undefined || input[key] === undefined) { invariant(check.optional === true, 'INVALID_ACTION_INPUT', 'A required input field is missing.'); continue; }
    check(input[key]);
  }
  return input ?? {};
};
const str = value => invariant(typeof value === 'string' && value.length > 0 && value.length <= 200, 'INVALID_ACTION_INPUT', 'A valid string field is required.');
const optStr = optional(value => invariant(value === null || (typeof value === 'string' && value.length <= 200), 'INVALID_ACTION_INPUT', 'Invalid optional string field.'));
const id = value => uuid(value);
const list = value => invariant(Array.isArray(value) && value.length <= 200 && value.every(v => typeof v === 'string' && v.length <= 100), 'INVALID_ACTION_INPUT', 'A list of identifiers is required.');

export function createActions(ctx) {
  const { db, domain, payments, payouts, recovery, parcels: parcelService } = ctx;
  const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));
  const many = async (sql, args = []) => db.transaction(async tx => (await tx.query(sql, args)).rows);

  // Operator boundary: a principal scoped to one operator can never widen its
  // view, whether through input or through a missing filter.
  async function scopeOperator(executor, requested) {
    const bound = executor?.agent?.operatorId ?? null;
    if (bound) invariant(!requested || requested === bound, 'FORBIDDEN', 'Operation is not permitted.', 403);
    return requested ?? bound;
  }

  return {
    'service.inspect': { category: 'read', approval: 'never', scope: 'service.read', description: 'Inspect active services (status, route, assignment).',
      input: { operatorId: optStr }, async run(executor, input) {
        const { operatorId } = validate(this.input, input);
        return many(`SELECT s.*,r.name AS route_name,v.registration,u.display_name AS driver_name FROM services s
          JOIN routes r ON r.id=s.route_id LEFT JOIN service_assignments a ON a.service_id=s.id AND a.ended_at IS NULL
          LEFT JOIN vehicles v ON v.id=a.vehicle_id LEFT JOIN users u ON u.id=a.driver_id
          WHERE s.status IN ('scheduled','active','disrupted') AND ($1::uuid IS NULL OR s.operator_id=$1)
          ORDER BY s.departure_at LIMIT 100`, [await scopeOperator(executor, operatorId)]);
      } },
    'service.capacity': { category: 'read', approval: 'never', scope: 'service.read', description: 'Inspect per-segment capacity of a service.',
      input: { serviceId: id }, async run(executor, input) {
        const { serviceId } = validate(this.input, input);
        const service = await one('SELECT * FROM services WHERE id=$1', [serviceId]);
        invariant(service, 'NOT_FOUND', 'Service not found.', 404);
        await scopeOperator(executor, service.operator_id);
        const last = await one('SELECT max(sequence)::integer AS last FROM service_stops WHERE service_id=$1', [serviceId]);
        if (service.current_sequence >= last.last) return { serviceId, available: 0, capacity: service.capacity, completed: true };
        return domain.availability(serviceId, service.current_sequence, last.last);
      } },
    'incident.inspect': { category: 'read', approval: 'never', scope: 'incident.read', description: 'Inspect open incidents.',
      input: { serviceId: optStr, operatorId: optStr }, async run(executor, input) {
        const { serviceId, operatorId } = validate(this.input, input);
        return many(`SELECT i.*,s.operator_id,r.name AS route_name FROM incidents i JOIN services s ON s.id=i.service_id JOIN routes r ON r.id=s.route_id
          WHERE i.status<>'resolved' AND ($1::uuid IS NULL OR i.service_id=$1) AND ($2::uuid IS NULL OR s.operator_id=$2)
          ORDER BY i.created_at DESC LIMIT 100`, [serviceId ?? null, await scopeOperator(executor, operatorId)]);
      } },
    'recovery.propose': { category: 'read', approval: 'never', scope: 'incident.read', description: 'Propose an eligible replacement for an incident (no mutation).',
      input: { incidentId: id, vehicleId: optStr, driverId: optStr }, async run(executor, input) {
        const { incidentId } = validate(this.input, input);
        const incident = await one("SELECT * FROM incidents WHERE id=$1 AND status<>'resolved'", [incidentId]);
        invariant(incident, 'INVALID_INCIDENT', 'An open incident is required.', 404);
        const service = await one('SELECT * FROM services WHERE id=$1', [incident.service_id]);
        invariant(service, 'NOT_FOUND', 'Service not found.', 404);
        await scopeOperator(executor, service.operator_id);
        const vehicles = await many(`SELECT v.* FROM vehicles v WHERE v.operator_id=$1 AND v.status='active' AND v.capacity>=$2
          AND NOT EXISTS(SELECT 1 FROM service_assignments a WHERE a.vehicle_id=v.id AND a.ended_at IS NULL) ORDER BY v.capacity`, [service.operator_id, service.capacity]);
        const affected = await one(`SELECT count(*)::integer AS count FROM bookings WHERE service_id=$1 AND status IN ('held','confirmed','boarded') AND destination_sequence>$2`, [service.id, service.current_sequence]);
        return { serviceId: service.id, operatorId: service.operator_id, incidentId, affectedPassengers: affected?.count ?? 0, eligibleVehicles: vehicles };
      } },
    'recovery.assign': { category: 'privileged', approval: 'always', scope: 'incident.manage', description: 'Assign a replacement vehicle (existing assignments are closed).',
      input: { serviceId: id, incidentId: id, vehicleId: id, driverId: id }, async run(executor, input) {
        const payload = validate(this.input, input);
        // Execution is attributed to the approving Ops operator; the agent is never an Ops user.
        return recovery.assign(executor, payload);
      } },
    'notification.send': { category: 'low_risk', approval: 'never', scope: 'notification.send', description: 'Queue a notification to recipients (audited outbox event).',
      input: { recipients: list, template: str, data: value => invariant(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_ACTION_INPUT', 'Notification data must be an object.') },
      async run(executor, input) {
        const { recipients, template, data } = validate(this.input, input);
        return db.transaction(async tx => {
          for (const recipient of recipients) {
            uuid(recipient);
            invariant((await tx.query('SELECT id FROM users WHERE id=$1 AND active=true', [recipient])).rowCount, 'INVALID_RECIPIENT', 'Recipient is not an active user.', 409);
          }
          const row = (await tx.query(`INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('notification.send',$1,$2) RETURNING id`, [executor.id ?? executor.workflowRunId, JSON.stringify({ recipients, template, data })])).rows[0];
          await tx.query('INSERT INTO audit_events(principal_id,action,entity_id,details) VALUES($1,$2,$3,$4)', [executor?.agent?.id ?? null, 'notification.send', row.id, JSON.stringify({ template, recipientCount: recipients.length })]);
          return { queued: recipients.length };
        });
      } },
    'payment.inspect': { category: 'read', approval: 'never', scope: 'payment.reconcile', description: 'Inspect provider payments needing attention.',
      input: { status: optStr }, async run(executor, input) {
        const { status } = validate(this.input, input);
        invariant(status == null || ['pending', 'succeeded', 'failed', 'cancelled', 'refunded'].includes(status), 'INVALID_ACTION_INPUT', 'Invalid payment status.');
        return many(`SELECT p.*,b.passenger_id,s.operator_id,u.display_name AS passenger_name FROM payments p
          JOIN bookings b ON b.id=p.booking_id JOIN services s ON s.id=b.service_id JOIN users u ON u.id=b.passenger_id
          WHERE p.provider='fedapay' AND ($1::text IS NULL OR p.status=$1) AND ($2::uuid IS NULL OR s.operator_id=$2)
          ORDER BY p.created_at DESC LIMIT 100`, [status, await scopeOperator(executor, null)]);
      } },
    'payment.reconcile': { category: 'financial', approval: 'always', scope: 'payment.reconcile', description: 'Reconcile a payment against the trusted provider state.',
      input: { paymentId: id }, async run(executor, input) {
        const { paymentId } = validate(this.input, input);
        const payment = await payments.getById(paymentId);
        const booking = await one('SELECT service_id FROM bookings WHERE id=$1', [payment.booking_id]);
        const service = await one('SELECT operator_id FROM services WHERE id=$1', [booking.service_id]);
        await scopeOperator(executor, service.operator_id);
        return payments.reconcile(executor, paymentId);
      } },
    'payout.inspect': { category: 'read', approval: 'never', scope: 'payout.review', description: 'Inspect driver payout requests.',
      input: { status: optStr }, async run(executor, input) {
        const { status } = validate(this.input, input);
        invariant(status == null || ['requested', 'processing', 'paid', 'failed', 'cancelled', 'reversed'].includes(status), 'INVALID_ACTION_INPUT', 'Invalid payout status.');
        return many(`SELECT r.*,u.display_name AS driver_name FROM payout_requests r JOIN users u ON u.id=r.driver_id
          WHERE ($1::text IS NULL OR r.status=$1) AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM driver_profiles dp WHERE dp.user_id=r.driver_id AND dp.operator_id=$2))
          ORDER BY r.created_at DESC LIMIT 100`, [status, await scopeOperator(executor, null)]);
      } },
    'payout.execute': { category: 'financial', approval: 'always', scope: 'payout.review', description: 'Approve and send a driver payout through the provider.',
      input: { payoutRequestId: id }, async run(executor, input) {
        const { payoutRequestId } = validate(this.input, input);
        const { row } = await payouts.getById(payoutRequestId);
        const profile = await one('SELECT operator_id FROM driver_profiles WHERE user_id=$1', [row.driver_id]);
        await scopeOperator(executor, profile?.operator_id ?? null);
        if (['processing', 'paid'].includes(row.status)) return { payoutRequestId, status: row.status, alreadyExecuted: true };
        return payouts.approve(executor, payoutRequestId);
      } },
    'payout.escalate': { category: 'low_risk', approval: 'never', scope: 'payout.review', description: 'Escalate a payout anomaly into an operational alert.',
      input: { payoutRequestId: id, reason: str }, async run(executor, input) {
        const { payoutRequestId, reason } = validate(this.input, input);
        const { row } = await payouts.getById(payoutRequestId);
        const profile = await one('SELECT operator_id FROM driver_profiles WHERE user_id=$1', [row.driver_id]);
        await scopeOperator(executor, profile?.operator_id ?? null);
        return db.transaction(async tx => {
          const alert = (await tx.query(`INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('alert.created',$1,$2) RETURNING id`, [row.id, JSON.stringify({ kind: 'payout_anomaly', payoutRequestId, driverId: row.driver_id, reason })])).rows[0];
          await tx.query('INSERT INTO audit_events(principal_id,action,entity_id,details) VALUES($1,$2,$3,$4)', [executor?.agent?.id ?? null, 'payout.escalated', row.id, JSON.stringify({ reason })]);
          return { alertId: alert.id };
        });
      } },
    'alert.create': { category: 'low_risk', approval: 'never', scope: 'alert.create', description: 'Create an operational alert for the Ops dashboard.',
      input: { kind: str, message: str, serviceId: optStr }, async run(executor, input) {
        const { kind, message, serviceId } = validate(this.input, input);
        invariant(['delay', 'recovery', 'payment', 'payout', 'parcel', 'other'].includes(kind), 'INVALID_ACTION_INPUT', 'Alert kind is invalid.');
        return db.transaction(async tx => {
          if (serviceId) {
            uuid(serviceId);
            const service = (await tx.query('SELECT operator_id FROM services WHERE id=$1', [serviceId])).rows[0];
            invariant(service, 'NOT_FOUND', 'Service not found.', 404);
            await scopeOperator(executor, service.operator_id);
          }
          const alert = (await tx.query(`INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('alert.created',$1,$2) RETURNING id`, [serviceId ?? executor.id ?? executor.workflowRunId, JSON.stringify({ kind, message, serviceId })])).rows[0];
          await tx.query('INSERT INTO audit_events(principal_id,action,entity_id,details) VALUES($1,$2,$3,$4)', [executor?.agent?.id ?? null, 'alert.created', alert.id, JSON.stringify({ kind })]);
          return { alertId: alert.id };
        });
      } },
    'route.status_summary': { category: 'read', approval: 'never', scope: 'service.read', description: 'Summarize route/service status for an operator.',
      input: { routeId: optStr }, async run(executor, input) {
        const { routeId } = validate(this.input, input);
        return many(`SELECT r.id AS route_id,r.name AS route_name,s.status,count(*)::integer AS services,count(i.id)::integer AS open_incidents
          FROM routes r JOIN services s ON s.route_id=r.id LEFT JOIN incidents i ON i.service_id=s.id AND i.status<>'resolved'
          WHERE ($1::uuid IS NULL OR r.id=$1) AND ($2::uuid IS NULL OR r.operator_id=$2)
          GROUP BY r.id,r.name,s.status ORDER BY r.name,s.status LIMIT 200`, [routeId, await scopeOperator(executor, null)]);
      } },
    // --- Parcel Logistics agentic actions ---
    'parcel.inspect': { category: 'read', approval: 'never', scope: 'parcel.read', description: 'Inspect parcels by status.',
      input: { status: optStr }, async run(executor, input) {
        const { status } = validate(this.input, input);
        invariant(status == null || ['created', 'accepted', 'manifested', 'loaded', 'in_transit', 'arrived', 'ready_for_pickup', 'collected', 'cancelled', 'rejected', 'held', 'damaged', 'lost', 'return_requested', 'returned'].includes(status), 'INVALID_ACTION_INPUT', 'Invalid parcel status.');
        return many(`SELECT p.*,s.name AS origin_city,d.name AS destination_city FROM parcels p
          JOIN stops s ON s.id=p.origin_stop_id JOIN stops d ON d.id=p.destination_stop_id
          WHERE ($1::text IS NULL OR p.status=$1) AND ($2::uuid IS NULL OR p.operator_id=$2)
          ORDER BY p.created_at DESC LIMIT 100`, [status, await scopeOperator(executor, null)]);
      } },
    'parcel.delayed_inspect': { category: 'read', approval: 'never', scope: 'parcel.read', description: 'Inspect loaded/in-transit parcels with stale or missing ETAs.',
      input: {}, async run(executor) {
        validate(this.input, undefined);
        return many(`SELECT p.*,a.service_id FROM parcels p JOIN parcel_service_assignments a ON a.parcel_id=p.id AND a.status IN ('loaded','in_transit')
          WHERE p.status IN ('loaded','in_transit') AND ($1::uuid IS NULL OR p.operator_id=$1)
          AND (p.eta_at IS NULL OR p.eta_at < now()) ORDER BY p.created_at DESC LIMIT 100`, [await scopeOperator(executor, null)]);
      } },
    'parcel.uncollected': { category: 'read', approval: 'never', scope: 'parcel.read', description: 'Inspect parcels waiting for pickup beyond 24 hours.',
      input: {}, async run(executor) {
        validate(this.input, undefined);
        return many(`SELECT p.*,s.name AS destination_city FROM parcels p JOIN stops s ON s.id=p.destination_stop_id
          WHERE p.status='ready_for_pickup' AND p.updated_at < now() - interval '24 hours'
          AND ($1::uuid IS NULL OR p.operator_id=$1) ORDER BY p.updated_at LIMIT 100`, [await scopeOperator(executor, null)]);
      } },
    'parcel.eta_update': { category: 'low_risk', approval: 'never', scope: 'parcel.manage', description: 'Update a parcel ETA (audited, no other mutation).',
      input: { parcelId: id, etaAt: str }, async run(executor, input) {
        const { parcelId, etaAt } = validate(this.input, input);
        return parcelService.updateEta(executor, { parcelId, etaAt });
      } },
    'parcel.delay_notice': { category: 'low_risk', approval: 'never', scope: 'parcel.manage', description: 'Record a parcel.delayed event for an in-transit parcel.',
      input: { parcelId: id, reason: str }, async run(executor, input) {
        const { parcelId, reason } = validate(this.input, input);
        return parcelService.markDelayed(executor, { parcelId, reason });
      } },
    'parcel.notify': { category: 'low_risk', approval: 'never', scope: 'parcel.notify', description: 'Queue a parcel notification to a party (channel integration pending).',
      input: { parcelId: id, party: str }, async run(executor, input) {
        const { parcelId, party } = validate(this.input, input);
        invariant(['sender', 'receiver'].includes(party), 'INVALID_ACTION_INPUT', 'Party must be sender or receiver.');
        const parcel = await one('SELECT id,operator_id FROM parcels WHERE id=$1', [parcelId]);
        invariant(parcel, 'NOT_FOUND', 'Parcel not found.', 404);
        await scopeOperator(executor, parcel.operator_id);
        return db.transaction(async tx => {
          const row = (await tx.query(`INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('notification.send',$1,$2) RETURNING id`,
            [executor.id ?? executor.workflowRunId, JSON.stringify({ kind: 'parcel', parcelId, party })])).rows[0];
          await tx.query('INSERT INTO audit_events(principal_id,action,entity_id,details) VALUES($1,$2,$3,$4)',
            [executor?.agent?.id ?? null, 'parcel.notified', parcelId, JSON.stringify({ party })]);
          return { queued: row.id !== undefined };
        });
      } },
    'parcel.escalate': { category: 'low_risk', approval: 'never', scope: 'parcel.manage', description: 'Escalate a parcel problem into an operational alert.',
      input: { parcelId: id, reason: str }, async run(executor, input) {
        const { parcelId, reason } = validate(this.input, input);
        const parcel = await one('SELECT id,operator_id,tracking_number FROM parcels WHERE id=$1', [parcelId]);
        invariant(parcel, 'NOT_FOUND', 'Parcel not found.', 404);
        await scopeOperator(executor, parcel.operator_id);
        return db.transaction(async tx => {
          const alert = (await tx.query(`INSERT INTO outbox(event_type,aggregate_id,payload) VALUES('alert.created',$1,$2) RETURNING id`,
            [parcelId, JSON.stringify({ kind: 'parcel', parcelId, trackingNumber: parcel.tracking_number, reason })])).rows[0];
          await tx.query('INSERT INTO audit_events(principal_id,action,entity_id,details) VALUES($1,$2,$3,$4)',
            [executor?.agent?.id ?? null, 'parcel.escalated', parcelId, JSON.stringify({ reason })]);
          return { alertId: alert.id };
        });
      } },
    'parcel.reassign': { category: 'privileged', approval: 'always', scope: 'parcel.manage', description: 'Reassign a parcel to a replacement service (custody transfer recorded).',
      input: { parcelId: id, serviceId: id }, async run(executor, input) {
        const payload = validate(this.input, input);
        return parcelService.reassign(executor, payload);
      } },
    'parcel.reconcile_payment': { category: 'financial', approval: 'always', scope: 'payment.reconcile', description: 'Reconcile a parcel payment against the parcel price.',
      input: { parcelPaymentId: id }, async run(executor, input) {
        const { parcelPaymentId } = validate(this.input, input);
        return parcelService.reconcilePayment(executor, { parcelPaymentId });
      } },
    'parcel.exception_report': { category: 'read', approval: 'never', scope: 'parcel.read', description: 'Station exception report: open parcel exceptions per operator.',
      input: {}, async run(executor) {
        validate(this.input, undefined);
        return many(`SELECT e.*,p.tracking_number,p.status AS parcel_status,p.operator_id FROM parcel_exceptions e JOIN parcels p ON p.id=e.parcel_id
          WHERE e.status='open' AND ($1::uuid IS NULL OR p.operator_id=$1) ORDER BY e.created_at LIMIT 100`, [await scopeOperator(executor, null)]);
      } },
  };
}

export function catalog(actions, agent) {
  return Object.entries(actions).filter(([, action]) => !agent || agent.scopes.includes(action.scope))
    .map(([name, action]) => ({ name, description: action.description, category: action.category, approval: action.approval, scope: action.scope }));
}
