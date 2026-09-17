import { randomUUID, createHash } from 'node:crypto';
import { DomainError, invariant, uuid } from '@leroutier/domain';

// Lightweight workflow engine over the existing outbox/audit architecture.
// Workflows react to domain events, execute typed actions with retries and
// idempotency, pause on human-approval gates and record every mutation.
// Agents never touch the database directly: every step runs through the same
// domain services as the human-facing API.
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

// Resolve tenant ownership from authoritative rows, never an event/model claim.
async function operatorFor(tx, aggregateId, input = {}) {
  const ids=[aggregateId,input.serviceId,input.incidentId,input.parcelId,input.bookingId,input.paymentId,input.payoutId,input.driverId]
    .filter(id=>typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  const result=await tx.query(`SELECT operator_id FROM (
    SELECT operator_id FROM services WHERE id=ANY($1::uuid[])
    UNION SELECT s.operator_id FROM incidents i JOIN services s ON s.id=i.service_id WHERE i.id=ANY($1::uuid[])
    UNION SELECT operator_id FROM parcels WHERE id=ANY($1::uuid[])
    UNION SELECT s.operator_id FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=ANY($1::uuid[])
    UNION SELECT s.operator_id FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN services s ON s.id=b.service_id WHERE p.id=ANY($1::uuid[])
    UNION SELECT operator_id FROM driver_profiles WHERE user_id=ANY($1::uuid[])
    UNION SELECT d.operator_id FROM payout_requests p JOIN driver_profiles d ON d.user_id=p.driver_id WHERE p.id=ANY($1::uuid[])
  ) tenants WHERE operator_id IS NOT NULL`,[ids]);
  return result.rows.length===1?result.rows[0].operator_id:null;
}

// Built-in workflow definitions. Step shapes:
//   { action:'catalog.name', approval?:boolean, input:(ctx)=>input }  — typed catalog action
//   { name:'step', run:(ctx,executor)=>result }                        — engine-local step
/**
 * @param {{ actions: Record<string, any>, reasoning?: any,
 *   triage?: { minDelayMinutes?: number, minStationaryMinutes?: number } }} deps
 */
export function createWorkflows({ actions, reasoning = null, triage = {} }) {
  // Deterministic thresholds decide whether a situation is worth reasoning
  // about at all. They are configuration because "how late is late" is an
  // operator's judgement, not a constant to invent in a scheduler.
  const minDelay = Number.isFinite(triage.minDelayMinutes) ? Number(triage.minDelayMinutes) : 15;
  const minStationary = Number.isFinite(triage.minStationaryMinutes) ? Number(triage.minStationaryMinutes) : 10;

  return {
    // The one workflow that asks a model anything.
    //
    // Shape, in order, and the order is the safety property:
    //   deterministic facts → deterministic threshold → PII-free projection
    //   → model → catalog validation → an Ops approval carrying the evidence.
    //
    // It proposes; it never acts. Running at `recommend` means even the alert
    // that carries the recommendation is something a human releases, and a
    // model that is slow, absent, over quota or wrong changes nothing at all:
    // `breakdown-recovery` and `parcel-breakdown` react to the same event and
    // do not consult it.
    'incident-triage': {
      trigger: 'incident.created', autonomy: 'recommend',
      description: 'Classify an open incident from operational facts and propose one low-risk next step for Ops to release.',
      steps: [
        { name: 'gather', reads: true, run: async (ctx, executor) => {
          if (!reasoning) return { skip: true, why: 'no_reasoning' };
          const facts = await executor.db.transaction(async tx => (await tx.query(
            `WITH latest AS (
               SELECT observed_at FROM vehicle_positions WHERE service_id=$1 ORDER BY observed_at DESC LIMIT 1
             ), moving AS (
               -- The last fix that was more than ~150 m from the newest one.
               -- How long ago that was is how long the vehicle has been where
               -- it is, which is the fact a stationary breakdown shows up as.
               SELECT max(p.observed_at) AS observed_at FROM vehicle_positions p, (
                 SELECT latitude, longitude FROM vehicle_positions WHERE service_id=$1 ORDER BY observed_at DESC LIMIT 1
               ) newest
               WHERE p.service_id=$1
                 AND (abs(p.latitude-newest.latitude) > 0.0015 OR abs(p.longitude-newest.longitude) > 0.0015)
             )
             SELECT s.status AS service_status, s.operator_id, s.departure_at, s.current_sequence,
                    i.kind AS incident_kind, i.status AS incident_status,
                    (SELECT count(*) FROM bookings b WHERE b.service_id=s.id AND b.status IN ('held','confirmed','boarded'))::integer AS passengers,
                    (SELECT count(*) FROM parcels p JOIN parcel_service_assignments a ON a.parcel_id=p.id AND a.service_id=s.id
                       WHERE p.status IN ('loaded','in_transit') AND a.status IN ('loaded','in_transit'))::integer AS parcels,
                    (SELECT pl.name FROM service_stops ss JOIN stops st ON st.id=ss.stop_id JOIN places pl ON pl.id=st.place_id
                       WHERE ss.service_id=s.id AND ss.sequence > s.current_sequence ORDER BY ss.sequence LIMIT 1) AS next_stop_city,
                    (SELECT count(*) FROM vehicles v WHERE v.operator_id=s.operator_id AND v.status='active'
                       AND NOT EXISTS(SELECT 1 FROM service_assignments sa WHERE sa.vehicle_id=v.id AND sa.ended_at IS NULL))::integer AS spare_vehicles,
                    (SELECT count(*) FROM services alt WHERE alt.operator_id=s.operator_id AND alt.route_id=s.route_id
                       AND alt.id<>s.id AND alt.status IN ('scheduled','active'))::integer AS alternative_services,
                    (SELECT observed_at FROM latest) AS last_fix_at,
                    (SELECT observed_at FROM moving) AS last_movement_at
             FROM incidents i JOIN services s ON s.id=i.service_id WHERE i.id=$2 AND i.service_id=$1`,
            [ctx.serviceId, ctx.incidentId])).rows[0]);
          if (!facts) return { skip: true, why: 'no_such_incident' };

          const ago = at => (at ? Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60_000)) : null);
          // Behind schedule is measured against departure for a service that
          // has not left, and is otherwise unknown rather than guessed: a
          // fabricated delay is worse than no delay.
          const delayMinutes = facts.service_status === 'scheduled' && facts.departure_at
            ? Math.max(0, ago(facts.departure_at)) : null;
          const signalAgeMinutes = ago(facts.last_fix_at);
          const situation = {
            serviceStatus: facts.service_status,
            delayMinutes,
            // No movement recorded at all means stationary since the first fix.
            vehicleStationaryMinutes: facts.last_fix_at ? ago(facts.last_movement_at ?? facts.last_fix_at) : null,
            signal: signalAgeMinutes === null ? 'unavailable' : signalAgeMinutes <= 10 ? 'live' : 'stale',
            signalAgeMinutes,
            passengersAffected: facts.passengers,
            parcelsAffected: facts.parcels,
            nextStopCity: facts.next_stop_city,
            openIncidentKind: facts.incident_status === 'resolved' ? null : facts.incident_kind,
            replacementVehiclesAvailable: facts.spare_vehicles,
            alternativeServicesAvailable: facts.alternative_services,
          };
          // The gate. A model is asked only when deterministic code already
          // considers the situation abnormal — an incident nobody is waiting
          // on, on a service carrying nobody, is not worth a remote call.
          const material = (situation.passengersAffected > 0 || situation.parcelsAffected > 0)
            && (['breakdown', 'accident', 'medical'].includes(situation.openIncidentKind)
              || (situation.delayMinutes ?? 0) >= minDelay
              || (situation.vehicleStationaryMinutes ?? 0) >= minStationary);
          return { skip: !material, why: material ? null : 'below_threshold', situation, operatorId: facts.operator_id };
        } },
        { name: 'triage', reads: true, when: ctx => !ctx.gather.skip, run: async (ctx, executor) => {
          // Never throws for a model problem: `recommend` returns a status.
          const verdict = await reasoning.recommend('incident.triage', ctx.gather.situation, {
            workflow: 'incident-triage',
            workflowRunId: ctx.workflowRunId,
            // A bound agent is checked against its own grant. A system run has
            // no grant to check, so the task's allowlist is the authority —
            // see reasoning.scopesFor.
            scopes: executor.agent?.scopes ?? reasoning.scopesFor('incident.triage'),
            operatorId: executor.agent?.operatorId ?? null,
            targetOperatorId: ctx.gather.operatorId,
          });
          // Only explainability fields are kept. No prompt, no raw completion,
          // no reasoning trace — the model was asked not to produce one.
          return {
            available: verdict.available,
            status: verdict.status,
            recommendation: verdict.recommendation ?? null,
            provider: verdict.providerUsed ?? null,
            actualModel: verdict.actualModel ?? null,
            latencyMs: verdict.latencyMs ?? null,
            fallbackUsed: Boolean(verdict.fallbackFrom),
          };
        } },
        { name: 'surface', when: ctx => !ctx.gather.skip && ctx.triage?.available, run: async (ctx, executor) => {
          const { classification, severity, reason } = ctx.triage.recommendation;
          const proposal = ctx.triage.recommendation.recommendedAction
            ? ` Piste proposée : ${ctx.triage.recommendation.recommendedAction}.`
            : ' Aucune action proposée.';
          await actions['alert.create'].run(executor, {
            kind: 'recovery', serviceId: ctx.serviceId,
            // Labelled as a suggestion, with its evidence, so nobody reads it
            // as a decision LeRoutier has already taken.
            message: `Analyse assistée (${severity}/${classification}) : ${reason}${proposal} À valider par l'exploitation.`,
          });
          return { surfaced: true };
        } },
      ],
    },
    'payment-reconciliation': {
      trigger: 'payment.anomaly', description: 'A provider webhook could not be reconciled automatically; propose a trusted reconciliation for review.',
      steps: [{ action: 'payment.reconcile', approval: true, input: ctx => ({ paymentId: ctx.paymentId }) }],
    },
    'breakdown-recovery': {
      trigger: 'incident.created', description: 'Propose a replacement vehicle for an incident and, after Ops approval, assign it and notify passengers.',
      steps: [
        { name: 'propose', reads: true, run: async (ctx, executor) => {
          const proposal = await actions['recovery.propose'].run(executor, { incidentId: ctx.incidentId });
          invariant(proposal.eligibleVehicles.length > 0, 'NO_REPLACEMENT', 'No eligible replacement vehicle is available.', 409);
          const drivers = await executor.db.transaction(async tx => (await tx.query(`SELECT u.id,u.display_name FROM driver_profiles dp JOIN users u ON u.id=dp.user_id
            WHERE dp.operator_id=$1 AND dp.active=true AND u.active=true
            AND NOT EXISTS(SELECT 1 FROM service_assignments a WHERE a.driver_id=dp.user_id AND a.ended_at IS NULL) ORDER BY u.display_name`, [proposal.operatorId])).rows);
          return { ...proposal, eligibleDrivers: drivers,
            selection: { serviceId: proposal.serviceId, incidentId: ctx.incidentId, vehicleId: proposal.eligibleVehicles[0].id, driverId: null } };
        } },
        { action: 'recovery.assign', approval: true, input: ctx => ctx.propose.selection },
        { name: 'notify', run: async (ctx, executor) => {
          const passengers = await executor.db.transaction(async tx => (await tx.query(`SELECT passenger_id FROM bookings WHERE service_id=$1 AND status IN ('held','confirmed','boarded')`, [ctx.propose.serviceId])).rows);
          if (!passengers.length) return { notified: 0 };
          return actions['notification.send'].run(executor, { recipients: passengers.map(p => p.passenger_id), template: 'replacement_assigned', data: { serviceId: ctx.propose.serviceId } });
        } },
      ],
    },
    'driver-payout': {
      trigger: 'payout.requested', description: 'Validate a driver withdrawal, prepare it, and after Ops approval execute it through the payout provider.',
      steps: [
        { name: 'validate', reads: true, run: async (ctx, executor) => {
          const rows = await executor.db.transaction(async tx => (await tx.query(`SELECT sum(net_minor)::integer AS reserved FROM driver_earnings WHERE payout_request_id=$1 AND payout_state='reserved'`, [ctx.payoutRequestId])).rows);
          invariant(rows[0]?.reserved >= ctx.amountMinor, 'PAYOUT_BALANCE', 'Reserved balance no longer covers the request.', 409);
          return { reservedMinor: rows[0].reserved };
        } },
        { action: 'payout.execute', approval: true, input: ctx => ({ payoutRequestId: ctx.payoutRequestId }) },
      ],
    },
    'delay-management': {
      trigger: 'service.position', description: 'Evaluate a position update against open delay incidents, notify affected passengers and surface Ops.',
      steps: [
        { name: 'evaluate', reads: true, run: async (ctx, executor) => {
          const open = await executor.db.transaction(async tx => (await tx.query(`SELECT id FROM incidents WHERE service_id=$1 AND kind='delay' AND status<>'resolved' ORDER BY created_at DESC LIMIT 1`, [ctx.serviceId])).rows);
          return { delayed: open.length > 0, incidentId: open[0]?.id ?? null };
        } },
        { name: 'notify', when: ctx => ctx.evaluate.delayed, run: async (ctx, executor) => {
          const passengers = await executor.db.transaction(async tx => (await tx.query(`SELECT DISTINCT passenger_id FROM bookings WHERE service_id=$1 AND status IN ('held','confirmed','boarded')`, [ctx.serviceId])).rows);
          if (!passengers.length) return { notified: 0 };
          return actions['notification.send'].run(executor, { recipients: passengers.map(p => p.passenger_id), template: 'service_delayed', data: { serviceId: ctx.serviceId } });
        } },
        { name: 'surface', when: ctx => ctx.evaluate.delayed, run: async (ctx, executor) => {
          await actions['alert.create'].run(executor, { kind: 'delay', serviceId: ctx.serviceId, message: 'Retard détecté sur le service; les passagers concernés ont été notifiés.' });
          return { flagged: true };
        } },
      ],
    },
    'parcel-delay': {
      trigger: 'service.position', description: 'Detect parcels on a delayed service, record parcel.delay events, notify receivers and surface an Ops alert.',
      steps: [
        { name: 'detect', reads: true, run: async (ctx, executor) => {
          const open = await executor.db.transaction(async tx => (await tx.query(`SELECT id FROM incidents WHERE service_id=$1 AND kind='delay' AND status<>'resolved' ORDER BY created_at DESC LIMIT 1`, [ctx.serviceId])).rows);
          if (!open.length) return { skip: true };
          const rows = await executor.db.transaction(async tx => (await tx.query(`SELECT p.id,p.tracking_number,p.operator_id FROM parcels p
            JOIN parcel_service_assignments a ON a.parcel_id=p.id AND a.status IN ('loaded','in_transit')
            WHERE p.status IN ('loaded','in_transit') AND a.service_id=$1`, [ctx.serviceId])).rows);
          return { skip: rows.length === 0, parcels: rows };
        } },
        { name: 'mark', when: ctx => !ctx.detect.skip, run: async (ctx, executor) => {
          for (const parcel of ctx.detect.parcels) {
            await actions['parcel.delay_notice'].run(executor, { parcelId: parcel.id, reason: 'Retard signalé sur le service de transport.' });
          }
          return { marked: ctx.detect.parcels.length };
        } },
        { name: 'notify', when: ctx => !ctx.detect.skip, run: async (ctx, executor) => {
          for (const parcel of ctx.detect.parcels) {
            await actions['parcel.notify'].run(executor, { parcelId: parcel.id, party: 'receiver' });
          }
          await actions['alert.create'].run(executor, { kind: 'delay', serviceId: ctx.serviceId, message: `Colis retardés : ${ctx.detect.parcels.length} expédition(s) affectée(s).` });
          return { notified: ctx.detect.parcels.length };
        } },
      ],
    },
    'payout-anomaly': {
      trigger: 'payout.anomaly', description: 'A payout event could not be reconciled automatically; surface it for Ops review.',
      steps: [
        { name: 'surface', run: async (ctx, executor) => {
          await actions['alert.create'].run(executor, { kind: 'payout', serviceId: null, message: 'Anomalie de versement détectée — à examiner dans les versements conducteurs.' });
          return { flagged: true };
        } },
      ],
    },
    'parcel-exception': {
      trigger: 'parcel.exception', description: 'A parcel exception was recorded; surface it and notify the receiver when the parcel is damaged, lost or held.',
      steps: [
        { name: 'surface', run: async (ctx, executor) => {
          if (['damaged', 'lost', 'held', 'return_requested'].includes(ctx.kind)) {
            await actions['parcel.notify'].run(executor, { parcelId: ctx.parcelId, party: 'receiver' });
          }
          await actions['alert.create'].run(executor, { kind: 'parcel', serviceId: null, message: `Exception colis ${ctx.kind} : ${ctx.trackingNumber}` });
          return { flagged: true };
        } },
      ],
    },
    'parcel-breakdown': {
      trigger: 'incident.created', description: 'Detect parcels on the affected service, propose a replacement and, after Ops approval, reassign custody and notify.',
      steps: [
        { name: 'detect', reads: true, run: async (ctx, executor) => {
          const rows = await executor.db.transaction(async tx => (await tx.query(`SELECT p.id,p.tracking_number,p.operator_id FROM parcels p
            JOIN parcel_service_assignments a ON a.parcel_id=p.id AND a.status IN ('loaded','in_transit')
            WHERE p.status IN ('loaded','in_transit') AND a.service_id=$1`, [ctx.serviceId])).rows);
          if (!rows.length) return { skip: true };
          const candidates = await executor.db.transaction(async tx => (await tx.query(`SELECT s.id,s.departure_at,r.name AS route_name FROM services s JOIN routes r ON r.id=s.route_id
            WHERE s.operator_id=$1 AND s.status IN ('scheduled','active') AND s.id<>$2 ORDER BY s.departure_at LIMIT 10`, [rows[0].operator_id, ctx.serviceId])).rows);
          return { skip: candidates.length === 0, parcels: rows, candidates };
        } },
        { action: 'parcel.reassign', approval: true, when: ctx => !ctx.detect.skip, input: ctx => ({ parcelId: ctx.detect.parcels[0].id, serviceId: ctx.detect.candidates[0].id }) },
        { name: 'notify', when: ctx => !ctx.detect.skip, run: async (ctx, executor) => {
          await actions['parcel.notify'].run(executor, { parcelId: ctx.detect.parcels[0].id, party: 'receiver' });
          await actions['alert.create'].run(executor, { kind: 'recovery', serviceId: ctx.serviceId, message: 'Colis transféré vers un service de remplacement après incident.' });
          return { notified: 1 };
        } },
      ],
    },
    // A parcel that arrived and was never collected. The thresholds live in
    // configuration (PARCEL_UNCOLLECTED_*), and the time-based sweep in
    // packages/database/src/reminders.js raises these as ordinary outbox
    // events — so they travel the same policy path as every other notification
    // rather than through a second scheduler.
    'parcel-uncollected-reminder': {
      trigger: 'parcel.uncollected_reminder', autonomy: 'auto_low_risk',
      description: 'A parcel has been collectable for longer than the reminder threshold; remind the receiver.',
      steps: [
        { name: 'notify', run: async (ctx, executor) => {
          await actions['parcel.notify'].run(executor, { parcelId: ctx.parcelId, party: 'receiver' });
          return { reminded: 1, waitingHours: ctx.waitingHours };
        } },
      ],
    },
    'parcel-uncollected-escalation': {
      trigger: 'parcel.uncollected_escalation', autonomy: 'auto_low_risk',
      description: 'A parcel is still uncollected past the escalation threshold; remind the receiver and ask the station to act.',
      steps: [
        { name: 'notify', run: async (ctx, executor) => {
          await actions['parcel.notify'].run(executor, { parcelId: ctx.parcelId, party: 'receiver' });
          return { reminded: 1 };
        } },
        { name: 'surface', run: async (ctx, executor) => {
          // What Ops sees is the fact and its evidence — tracking number and
          // how long it has waited — never a recommendation without a reason.
          await actions['alert.create'].run(executor, { kind: 'parcel', serviceId: null,
            message: `Colis non retiré depuis ${ctx.waitingHours} h : ${ctx.trackingNumber} — à traiter en gare.` });
          return { flagged: true };
        } },
      ],
    },
  };
}

// onEvent is an optional per-event hook used by notification dispatch. It runs
// in its own transaction inside the same outbox drain, so a notification
// failure can never roll back the business transaction that produced the event
// and never blocks workflow processing.
export function createWorkflowEngine({ db, actions, onEvent = null, autonomy = null, reasoning = null, triage = {} }) {
  const definitions = createWorkflows({ actions, reasoning, triage });
  const autonomyConfig = { default: 'auto_low_risk', workflows: {}, ...(autonomy ?? {}) };

  /**
   * How much this workflow may do without a human.
   *
   * Resolution order is explicit configuration, then the workflow's own
   * declared default, then the global default. Configuration can only ever be
   * consulted by name, so a workflow nobody has thought about inherits the
   * global setting rather than the most permissive one seen so far.
   */
  const levelFor = workflow => autonomyConfig.workflows[workflow]
    ?? definitions[workflow]?.autonomy
    ?? autonomyConfig.default;

  /** A step that only queries: safe to execute even while observing. */
  const readsOnly = step => step.reads === true || (step.action && actions[step.action]?.category === 'read');
  const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
  const stepKey = step => step.action ?? step.name;
  const audit = (tx, principalId, action, entityId, details) =>
    tx.query('INSERT INTO audit_events(principal_id,action,entity_id,details) VALUES($1,$2,$3,$4)', [principalId, action, entityId, JSON.stringify(details)]);

  async function principal(dbLayer, principalId) {
    if (!principalId) return null;
    const row = await dbLayer.transaction(async tx => one(tx, 'SELECT * FROM agent_principals WHERE id=$1 AND active=true', [principalId]));
    if (!row) return null;
    const scopes = await dbLayer.transaction(async tx => (await tx.query('SELECT scope FROM agent_scopes WHERE principal_id=$1', [row.id])).rows.map(r => r.scope));
    return { id: row.id, name: row.name, scopes, operatorId: row.operator_id ?? null };
  }

  function stepsFor(run) {
    if (run.workflow === 'agent-action') {
      const action = actions[run.context?.action];
      return [{ action: run.context.action, approval: action?.approval === 'always', input: ctx => ctx.input }];
    }
    return definitions[run.workflow]?.steps ?? null;
  }

  // Executes one run until it completes, fails or pauses on an approval gate.
  // Resumable and idempotent: re-invoking a completed run is a no-op; retries
  // never duplicate mutations because domain services keep their own receipts.
  async function executeRun(runId) {
    for (let guard = 0; guard < 50; guard++) {
      const run = await db.transaction(async tx => one(tx, 'SELECT * FROM workflow_runs WHERE id=$1 FOR UPDATE', [runId]));
      if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return run;
      const steps = stepsFor(run);
      if (!steps) {
        await db.transaction(async tx => { await audit(tx, run.principal_id, 'workflow.run_failed', runId, { workflow: run.workflow, code: 'UNKNOWN_WORKFLOW' }); await one(tx, "UPDATE workflow_runs SET status='failed',updated_at=now() WHERE id=$1", [runId]); });
        return db.transaction(async tx => one(tx, 'SELECT * FROM workflow_runs WHERE id=$1', [runId]));
      }
      const context = { ...run.context, workflowRunId: runId };
      const idx = steps.findIndex(step => stepKey(step) === run.step);
      if (idx === -1) {
        await db.transaction(async tx => { await audit(tx, run.principal_id, 'workflow.run_completed', runId, { workflow: run.workflow }); await one(tx, "UPDATE workflow_runs SET status='completed',step='done',updated_at=now() WHERE id=$1", [runId]); });
        return db.transaction(async tx => one(tx, 'SELECT * FROM workflow_runs WHERE id=$1', [runId]));
      }
      const step = steps[idx], key = stepKey(step);
      const agent = await principal(db, run.principal_id);
      let executor = { id: null, role: agent ? 'agent' : 'system', agent, workflowRunId: runId, db };
      try {
        // Conditional steps: when the condition is false the step is recorded
        // as skipped and the run advances without a mutation.
        if (step.when && !step.when(context)) {
          await db.transaction(async tx => {
            await one(tx, 'UPDATE workflow_runs SET context=$2,step=$3,updated_at=now() WHERE id=$1',
              [runId, JSON.stringify({ ...context, [key]: null }), steps[idx + 1] ? stepKey(steps[idx + 1]) : 'done']);
            await audit(tx, run.principal_id, 'workflow.step_skipped', runId, { workflow: run.workflow, step: key });
          });
          continue;
        }
        // Autonomy is applied here, once, for every workflow and every step —
        // not scattered through the definitions, where one omission would
        // quietly become an exception.
        const level = levelFor(run.workflow);
        if (level === 'observe' && !readsOnly(step)) {
          // Observation mode: record what would have happened and move on. This
          // is how recommendation quality is measured before autonomy is
          // widened — the run is complete and reviewable, and nothing changed.
          const proposed = step.input ? step.input(context) : {};
          await db.transaction(async tx => {
            await one(tx, 'UPDATE workflow_runs SET context=$2,step=$3,updated_at=now() WHERE id=$1',
              [runId, JSON.stringify({ ...context, [key]: { observed: true, proposed } }), steps[idx + 1] ? stepKey(steps[idx + 1]) : 'done']);
            await audit(tx, run.principal_id, 'workflow.step_observed', runId, { workflow: run.workflow, step: key, autonomy: level });
          });
          continue;
        }
        const requiresApproval = !!step.approval
          || (step.action && actions[step.action]?.approval === 'always')
          // 'recommend' gates every mutation; 'approval_required' gates
          // everything, reads included.
          || (level === 'recommend' && !readsOnly(step))
          || level === 'approval_required';
        if (requiresApproval) {
          const approval = await db.transaction(async tx => {
            const pending = await one(tx, "SELECT * FROM workflow_approvals WHERE workflow_run_id=$1 AND action=$2 AND status='pending' FOR UPDATE", [runId, key]);
            if (pending) { await one(tx, "UPDATE workflow_runs SET status='awaiting_approval',updated_at=now() WHERE id=$1", [runId]); return null; }
            const approved = await one(tx, "SELECT * FROM workflow_approvals WHERE workflow_run_id=$1 AND action=$2 AND status='approved'", [runId, key]);
            if (!approved) {
              const proposed = step.input ? step.input(context) : {};
              await tx.query('INSERT INTO workflow_approvals(workflow_run_id,action,rationale,proposed) VALUES($1,$2,$3,$4)',
                [runId, key, step.action ? actions[step.action].description : key, JSON.stringify(proposed)]);
              await audit(tx, run.principal_id, 'workflow.approval_requested', runId, { workflow: run.workflow, action: key });
              await one(tx, "UPDATE workflow_runs SET status='awaiting_approval',updated_at=now() WHERE id=$1", [runId]);
            }
            return approved;
          });
          if (!approval) return db.transaction(async tx => one(tx, 'SELECT * FROM workflow_runs WHERE id=$1', [runId]));
          // Approved: execution is attributed to the approving Ops operator; the
          // approved input (possibly revised by Ops) overrides the derived one.
          const decider = await db.transaction(async tx => {
            const row = await one(tx, 'SELECT * FROM users WHERE id=$1 AND active=true', [approval.decided_by]);
            invariant(row && row.role === 'ops', 'APPROVAL_DECIDER', 'The approving operator is no longer active.', 403);
            return row;
          });
          executor = { ...decider, role: 'ops', agent, workflowRunId: runId, db };
          const proposed = { ...(step.input ? step.input(context) : {}), ...approval.proposed };
          const result = step.action ? await actions[step.action].run(executor, proposed) : await step.run(context, executor);
          await db.transaction(async tx => {
            await one(tx, 'UPDATE workflow_runs SET context=$2,step=$3,attempts=0,updated_at=now() WHERE id=$1',
              [runId, JSON.stringify({ ...context, [key]: result }), steps[idx + 1] ? stepKey(steps[idx + 1]) : 'done']);
            await audit(tx, run.principal_id, 'workflow.step_completed', runId, { workflow: run.workflow, step: key, decidedBy: executor.id });
          });
        } else {
          const input = step.input ? step.input(context) : undefined;
          const result = step.action ? await actions[step.action].run(executor, input) : await step.run(context, executor);
          await db.transaction(async tx => {
            await one(tx, 'UPDATE workflow_runs SET context=$2,step=$3,attempts=0,updated_at=now() WHERE id=$1',
              [runId, JSON.stringify({ ...context, [key]: result }), steps[idx + 1] ? stepKey(steps[idx + 1]) : 'done']);
            await audit(tx, run.principal_id, 'workflow.step_completed', runId, { workflow: run.workflow, step: key });
          });
        }
      } catch (error) {
        if (error instanceof DomainError && !['NO_REPLACEMENT', 'PAYOUT_BALANCE'].includes(error.code)) {
          return db.transaction(async tx => {
            const current = await one(tx, 'SELECT * FROM workflow_runs WHERE id=$1 FOR UPDATE', [runId]);
            invariant(current, 'NOT_FOUND', 'Workflow run not found.', 404);
            if (current.status !== 'running') return current;
            await audit(tx, run.principal_id, 'workflow.step_failed', runId, { workflow: run.workflow, step: key, code: error.code, attempt: current.attempts + 1 });
            return one(tx, "UPDATE workflow_runs SET status='failed',attempts=attempts+1,context=$2,updated_at=now() WHERE id=$1 RETURNING *",
              [runId, JSON.stringify({ ...context, failure: { code: error.code, message: error.message, status: error.status ?? 400 } })]);
          });
        }
        
        await db.transaction(async tx => { await audit(tx, run.principal_id, 'workflow.run_cancelled', runId, { workflow: run.workflow, step: key, code: error.code }); await one(tx, "UPDATE workflow_runs SET status='cancelled',updated_at=now() WHERE id=$1", [runId]); });
        return db.transaction(async tx => one(tx, 'SELECT * FROM workflow_runs WHERE id=$1', [runId]));
      }
    }
    return db.transaction(async tx => one(tx, 'SELECT * FROM workflow_runs WHERE id=$1', [runId]));
  }

  return {
    definitions,
    // Consume undelivered outbox events and run matching workflows. Safe to
    // run concurrently: run creation is conflict-guarded and steps are idempotent.
    async processOutbox() {
      const events = await db.transaction(async tx => (await tx.query(`SELECT * FROM outbox WHERE delivered_at IS NULL
        AND dispatch_dead_at IS NULL AND (dispatch_retry_at IS NULL OR dispatch_retry_at<=now())
        ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED`)).rows);
      let processed = 0;
      for (const event of events) {
        // One domain event may trigger several workflows; each run is guarded
        // by its own uniqueness index and every step stays idempotent.
        const matches = Object.entries(definitions).filter(([, definition]) => definition.trigger === event.event_type);
        for (const [name] of matches) {
          // outbox.payload is jsonb: the driver already returns an object.
          let payload = {};
          try { payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : (event.payload && typeof event.payload === 'object' ? event.payload : {}); } catch { /* malformed payloads never crash the loop */ }
          const firstStep = definitions[name].steps[0] ? (definitions[name].steps[0].action ?? definitions[name].steps[0].name) : 'start';
          const eventFingerprint=digest([event.event_type,event.aggregate_id,payload]);
          const run = await db.transaction(async tx => {
            const inserted = await tx.query('INSERT INTO workflow_runs(workflow,trigger_event,aggregate_id,context,step,operator_id,event_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *',
              [name, event.event_type, event.aggregate_id, JSON.stringify(payload), firstStep, await operatorFor(tx,event.aggregate_id,payload),eventFingerprint]);
            if (inserted.rows[0]) return inserted.rows[0];
            return one(tx, "SELECT * FROM workflow_runs WHERE workflow=$1 AND event_fingerprint=$2 AND status IN ('running','awaiting_approval')", [name,eventFingerprint]);
          });
          if (run) await executeRun(run.id);
        }
        // Notification dispatch is isolated: an unavailable channel or a
        // malformed policy must not stop the drain or lose the event.
        if (onEvent) {
          try { await db.transaction(tx => onEvent(tx, event)); }
          catch {
            await db.transaction(tx=>tx.query(`UPDATE outbox SET dispatch_attempts=dispatch_attempts+1,
              dispatch_retry_at=now()+make_interval(secs=>LEAST(3600,30*power(2,dispatch_attempts))::integer),
              dispatch_dead_at=CASE WHEN dispatch_attempts>=4 THEN now() ELSE NULL END WHERE id=$1`,[event.id]));
            continue;
          }
        }
        await db.transaction(async tx => one(tx, 'UPDATE outbox SET delivered_at=now() WHERE id=$1 AND delivered_at IS NULL', [event.id]));
        processed++;
      }
      return { processed };
    },
    // Agent-initiated typed action. Approval-gated actions pause as a pending
    // approval and execute exactly once after an Ops decision.
    async runAction(agent, actionName, input, idempotencyKey = undefined) {
      const action = actions[actionName];
      invariant(action, 'NOT_FOUND', 'Unknown agent action.', 404);
      invariant(agent.scopes.includes(action.scope), 'FORBIDDEN', `Agent scope ${action.scope} is required.`, 403);
      const fingerprint = digest([agent.id, actionName, input]);
      if (idempotencyKey) {
        const prior = await db.transaction(async tx => one(tx, 'SELECT * FROM agent_action_receipts WHERE principal_id=$1 AND action=$2 AND idempotency_key=$3', [agent.id, actionName, idempotencyKey]));
        if (prior) { invariant(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Key was used for a different input.', 409); return { replayed: true, status: 'completed', pendingApproval: false, result: prior.result, workflowRunId: prior.workflow_run_id }; }
      }
      const context = { action: actionName, input, idempotencyKey: idempotencyKey ?? null, fingerprint };
      const run = await db.transaction(async tx => {
        const row = (await tx.query(`INSERT INTO workflow_runs(workflow,trigger_event,aggregate_id,principal_id,context,step,operator_id)
          VALUES('agent-action','agent.action',$1,$2,$3,$4,$5) RETURNING *`, [randomUUID(), agent.id, JSON.stringify(context), actionName,
          agent.operatorId ?? await operatorFor(tx,null,input)])).rows[0];
        await audit(tx, agent.id, 'agent.action.requested', row.id, { action: actionName, approval: action.approval });
        return row;
      });
      const finished = await executeRun(run.id);
      const result = finished?.context?.[actionName] ?? null;
      // Surface immediate failures to the caller with the original domain code.
      if (finished?.status === 'failed' && finished.context?.failure) {
        throw new DomainError(finished.context.failure.code, finished.context.failure.message, finished.context.failure.status);
      }
      if (finished && !['failed', 'cancelled'].includes(finished.status) && idempotencyKey) {
        await db.transaction(async tx => {
          const prior = await one(tx, 'SELECT * FROM agent_action_receipts WHERE principal_id=$1 AND action=$2 AND idempotency_key=$3', [agent.id, actionName, idempotencyKey]);
          if (!prior) await tx.query('INSERT INTO agent_action_receipts(principal_id,action,idempotency_key,fingerprint,result,workflow_run_id) VALUES($1,$2,$3,$4,$5,$6)',
            [agent.id, actionName, idempotencyKey, fingerprint, JSON.stringify(result), run.id]);
        });
      }
      return { workflowRunId: run.id, status: finished?.status ?? 'running', ...(result !== null ? { result } : {}), ...(finished?.status === 'awaiting_approval' ? { pendingApproval: true } : {}) };
    },
    async approve(actor, approvalId, decision, input = undefined) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      invariant(decision === 'approved' || decision === 'rejected', 'INVALID_DECISION', 'Decision must be approved or rejected.');
      invariant(input === undefined || (input && typeof input === 'object' && !Array.isArray(input)), 'INVALID_DECISION', 'Revised input must be an object.');
      const approval = await db.transaction(async tx => {
        const row = await one(tx, 'SELECT * FROM workflow_approvals WHERE id=$1 FOR UPDATE', [uuid(approvalId)]);
        invariant(row, 'NOT_FOUND', 'Approval not found.', 404);
        const run=await one(tx,'SELECT operator_id FROM workflow_runs WHERE id=$1',[row.workflow_run_id]);
        invariant(!actor.operator_id || actor.operator_id===run?.operator_id,'FORBIDDEN','Workflow belongs to another operator.',403);
        invariant(row.status === 'pending', 'APPROVAL_DECIDED', 'This approval was already decided.', 409);
        const proposed = input === undefined ? row.proposed : { ...row.proposed, ...input };
        return one(tx, 'UPDATE workflow_approvals SET status=$2,decided_by=$3,decided_at=now(),proposed=$4 WHERE id=$1 RETURNING *', [row.id, decision, actor.id, JSON.stringify(proposed)]);
      });
      await db.transaction(async tx => {
        await audit(tx, null, 'workflow.approval_decided', approval.workflow_run_id, { approvalId: approval.id, decision, decidedBy: actor.id });
        await one(tx, decision === 'approved' ? "UPDATE workflow_runs SET status='running',updated_at=now() WHERE id=$1" : "UPDATE workflow_runs SET status='cancelled',updated_at=now() WHERE id=$1", [approval.workflow_run_id]);
      });
      const finished = decision === 'approved' ? await executeRun(approval.workflow_run_id) : null;
      if (decision === 'approved' && finished?.context?.fingerprint && finished.context.idempotencyKey) {
        await db.transaction(async tx => {
          const prior = await one(tx, 'SELECT * FROM agent_action_receipts WHERE principal_id=$1 AND action=$2 AND idempotency_key=$3', [finished.principal_id, finished.context.action, finished.context.idempotencyKey]);
          if (!prior) await tx.query('INSERT INTO agent_action_receipts(principal_id,action,idempotency_key,fingerprint,result,workflow_run_id) VALUES($1,$2,$3,$4,$5,$6)',
            [finished.principal_id, finished.context.action, finished.context.idempotencyKey, finished.context.fingerprint, JSON.stringify(finished.context[finished.context.action] ?? null), finished.id]);
        });
      }
      return db.transaction(async tx => one(tx, 'SELECT * FROM workflow_runs WHERE id=$1', [approval.workflow_run_id]));
    },
    async retry(actor, runId) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      const run = await db.transaction(async tx => {
        const row = await one(tx, 'SELECT * FROM workflow_runs WHERE id=$1 FOR UPDATE', [uuid(runId)]);
        invariant(row, 'NOT_FOUND', 'Workflow run not found.', 404);
        invariant(!actor.operator_id || actor.operator_id===row.operator_id,'FORBIDDEN','Workflow belongs to another operator.',403);
        invariant(row.status === 'failed' && row.attempts < 3, 'WORKFLOW_RETRY', 'This workflow run cannot be retried.', 409);
        return one(tx, "UPDATE workflow_runs SET status='running',updated_at=now() WHERE id=$1 RETURNING *", [runId]);
      });
      await db.transaction(async tx => audit(tx, null, 'workflow.run_retried', runId, { decidedBy: actor.id }));
      return executeRun(run.id);
    },
    async listRuns(actor) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      return db.transaction(async tx => (await tx.query('SELECT * FROM workflow_runs WHERE ($1::uuid IS NULL OR operator_id=$1) ORDER BY created_at DESC LIMIT 50',[actor.operator_id??null])).rows);
    },
    async listApprovals(actor) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      return db.transaction(async tx => (await tx.query(`SELECT a.*,r.workflow,r.trigger_event,r.context FROM workflow_approvals a
        JOIN workflow_runs r ON r.id=a.workflow_run_id WHERE a.status='pending' AND ($1::uuid IS NULL OR r.operator_id=$1) ORDER BY a.created_at LIMIT 50`,[actor.operator_id??null])).rows);
    },
  };
}
