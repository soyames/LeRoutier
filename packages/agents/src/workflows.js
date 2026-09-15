import { randomUUID, createHash } from 'node:crypto';
import { DomainError, invariant, uuid } from '@leroutier/domain';

// Lightweight workflow engine over the existing outbox/audit architecture.
// Workflows react to domain events, execute typed actions with retries and
// idempotency, pause on human-approval gates and record every mutation.
// Agents never touch the database directly: every step runs through the same
// domain services as the human-facing API.
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

// Built-in workflow definitions. Step shapes:
//   { action:'catalog.name', approval?:boolean, input:(ctx)=>input }  — typed catalog action
//   { name:'step', run:(ctx,executor)=>result }                        — engine-local step
export function createWorkflows({ actions }) {
  return {
    'payment-reconciliation': {
      trigger: 'payment.anomaly', description: 'A provider webhook could not be reconciled automatically; propose a trusted reconciliation for review.',
      steps: [{ action: 'payment.reconcile', approval: true, input: ctx => ({ paymentId: ctx.paymentId }) }],
    },
    'breakdown-recovery': {
      trigger: 'incident.created', description: 'Propose a replacement vehicle for an incident and, after Ops approval, assign it and notify passengers.',
      steps: [
        { name: 'propose', run: async (ctx, executor) => {
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
        { name: 'validate', run: async (ctx, executor) => {
          const rows = await executor.db.transaction(async tx => (await tx.query(`SELECT sum(net_minor)::integer AS reserved FROM driver_earnings WHERE payout_request_id=$1 AND payout_state='reserved'`, [ctx.payoutRequestId])).rows);
          invariant(rows[0]?.reserved >= ctx.amountMinor, 'PAYOUT_BALANCE', 'Reserved balance no longer covers the request.', 409);
          return { reservedMinor: rows[0].reserved };
        } },
        { action: 'payout.execute', approval: true, input: ctx => ({ payoutRequestId: ctx.payoutRequestId }) },
      ],
    },
    'delay-management': {
      trigger: 'service.position', description: 'Evaluate a position update against open delay incidents and surface affected passengers to Ops.',
      steps: [
        { name: 'evaluate', run: async (ctx, executor) => {
          const open = await executor.db.transaction(async tx => (await tx.query(`SELECT id FROM incidents WHERE service_id=$1 AND kind='delay' AND status<>'resolved' ORDER BY created_at DESC LIMIT 1`, [ctx.serviceId])).rows);
          return { delayed: open.length > 0, incidentId: open[0]?.id ?? null };
        } },
        { name: 'surface', run: async (ctx, executor) => {
          if (!ctx.evaluate.delayed) return { flagged: false };
          await actions['alert.create'].run(executor, { kind: 'delay', serviceId: ctx.serviceId, message: 'Retard détecté sur le service; les passagers concernés sont à notifier.' });
          return { flagged: true };
        } },
      ],
    },
  };
}

export function createWorkflowEngine({ db, actions }) {
  const definitions = createWorkflows({ actions });
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
        const requiresApproval = !!step.approval || (step.action && actions[step.action]?.approval === 'always');
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
      const events = await db.transaction(async tx => (await tx.query('SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED')).rows);
      let processed = 0;
      for (const event of events) {
        const name = Object.keys(definitions).find(key => definitions[key].trigger === event.event_type);
        if (name) {
          // outbox.payload is jsonb: the driver already returns an object.
          let payload = {};
          try { payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : (event.payload && typeof event.payload === 'object' ? event.payload : {}); } catch { /* malformed payloads never crash the loop */ }
          const firstStep = definitions[name].steps[0] ? (definitions[name].steps[0].action ?? definitions[name].steps[0].name) : 'start';
          const run = await db.transaction(async tx => {
            const inserted = await tx.query('INSERT INTO workflow_runs(workflow,trigger_event,aggregate_id,context,step) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *',
              [name, event.event_type, event.aggregate_id, JSON.stringify(payload), firstStep]);
            if (inserted.rows[0]) return inserted.rows[0];
            return one(tx, "SELECT * FROM workflow_runs WHERE workflow=$1 AND aggregate_id=$2 AND trigger_event=$3 AND status IN ('running','awaiting_approval')", [name, event.aggregate_id, event.event_type]);
          });
          if (run) await executeRun(run.id);
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
        const row = (await tx.query(`INSERT INTO workflow_runs(workflow,trigger_event,aggregate_id,principal_id,context,step)
          VALUES('agent-action','agent.action',$1,$2,$3,$4) RETURNING *`, [randomUUID(), agent.id, JSON.stringify(context), actionName])).rows[0];
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
        invariant(row.status === 'failed' && row.attempts < 3, 'WORKFLOW_RETRY', 'This workflow run cannot be retried.', 409);
        return one(tx, "UPDATE workflow_runs SET status='running',updated_at=now() WHERE id=$1 RETURNING *", [runId]);
      });
      await db.transaction(async tx => audit(tx, null, 'workflow.run_retried', runId, { decidedBy: actor.id }));
      return executeRun(run.id);
    },
    async listRuns(actor) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      return db.transaction(async tx => (await tx.query('SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT 50')).rows);
    },
    async listApprovals(actor) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      return db.transaction(async tx => (await tx.query(`SELECT a.*,r.workflow,r.trigger_event,r.context FROM workflow_approvals a
        JOIN workflow_runs r ON r.id=a.workflow_run_id WHERE a.status='pending' ORDER BY a.created_at LIMIT 50`)).rows);
    },
  };
}
