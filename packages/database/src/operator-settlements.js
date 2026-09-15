import { createHash } from 'node:crypto';
import { invariant, uuid, idempotencyKey } from '@leroutier/domain';
import { audit, activeIdentity } from './identities.js';

// Operator revenue ledger. Revenue belongs to the OPERATOR: passenger and
// parcel payments flow through the service to the operator's settlement
// ledger. Independent owner-drivers may withdraw their own operator balance;
// company drivers and convoyeurs never can. No commission formula is
// invented — credits are created from trusted recorded activity only.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const emit = (tx, type, id, payload = {}) => tx.query(
  'INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)', [type, id, JSON.stringify(payload)]);

export function operatorSettlements(db, adapter = null) {
  const publicRequest = r => ({ id: r.id, operatorId: r.operator_id, amountMinor: r.amount_minor, currency: r.currency,
    phoneNumber: r.phone_number, country: r.country, network: r.network, provider: r.provider, providerReference: r.provider_reference,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, approvedBy: r.approved_by, decidedAt: r.decided_at });

  // View scope: platform ops, the operator owner or the company admin.
  async function viewScope(tx, actor, operatorId) {
    const user = await activeIdentity(tx, actor.id);
    const operator = await one(tx, 'SELECT * FROM operators WHERE id=$1', [operatorId]);
    invariant(operator, 'NOT_FOUND', 'Operator not found.', 404);
    if (user.role === 'ops' && !user.operator_id) return { user, operator, privileged: true };
    invariant((user.operator_id === operator.id && user.role === 'ops') || operator.owner_user_id === user.id,
      'FORBIDDEN', 'Operation is not permitted.', 403);
    return { user, operator, privileged: false };
  }
  // Withdrawal scope: only the owner of an independent operator can withdraw.
  // Company drivers, convoyeurs and admins never can.
  async function withdrawScope(tx, actor, operatorId) {
    const user = await activeIdentity(tx, actor.id);
    const operator = await one(tx, 'SELECT * FROM operators WHERE id=$1', [operatorId]);
    invariant(operator, 'NOT_FOUND', 'Operator not found.', 404);
    invariant(operator.owner_user_id === user.id && operator.type === 'independent' && user.role === 'driver',
      'FORBIDDEN', 'Seul le propriétaire d’un compte indépendant peut retirer son solde.', 403);
    return { user, operator };
  }
  async function reserve(tx, operatorId, amountMinor, requestId) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['operator-balance:' + operatorId]);
    const { rows } = await tx.query(`SELECT id,net_minor,deduction_minor,operator_id,source,reference,currency,earned_at,available_at
      FROM operator_settlements WHERE operator_id=$1 AND payout_state='available' AND available_at<=now()
      ORDER BY earned_at,id FOR UPDATE`, [operatorId]);
    let need = amountMinor; const ids = [];
    for (const row of rows) {
      ids.push(row.id);
      if (row.net_minor <= need) { need -= row.net_minor; if (need === 0) break; continue; }
      const excess = row.net_minor - need;
      await tx.query(`INSERT INTO operator_settlements(operator_id,source,reference,gross_minor,deduction_minor,currency,earned_at,available_at)
        VALUES($1,$2,$3,$4,0,$5,$6,$7)`,[row.operator_id,row.source,'split:'+row.reference,excess,row.currency,row.earned_at,row.available_at]);
      await tx.query('UPDATE operator_settlements SET gross_minor=$2 WHERE id=$1',[row.id,need + row.deduction_minor]);
      need = 0; break;
    }
    invariant(need === 0, 'INSUFFICIENT_BALANCE', 'Le solde opérateur ne couvre pas ce retrait.', 409);
    await tx.query('UPDATE operator_settlements SET payout_state=$2,payout_request_id=$3 WHERE id=ANY($1)', [ids, 'reserved', requestId]);
  }
  async function release(tx, requestId) {
    await tx.query(`UPDATE operator_settlements SET payout_state='available',payout_request_id=NULL
      WHERE payout_request_id=$1 AND payout_state='reserved'`, [requestId]);
  }
  async function apply(event) {
    invariant(event && Object.keys(event).every(k => ['payoutRequestId', 'eventId', 'reference', 'amountMinor', 'currency', 'status'].includes(k)),
      'INVALID_PAYOUT_EVENT', 'Invalid operator payout event.');
    uuid(event.payoutRequestId);
    invariant(typeof event.eventId === 'string' && event.eventId.length > 0 && event.eventId.length <= 150 &&
      typeof event.reference === 'string' && event.reference.length > 0 && event.reference.length <= 150 &&
      (event.amountMinor === undefined || Number.isInteger(event.amountMinor)) &&
      (event.currency === undefined || event.currency === 'XOF') &&
      ['requested', 'processing', 'paid', 'failed', 'cancelled', 'reversed'].includes(event.status), 'INVALID_PAYOUT_EVENT', 'Invalid operator payout event.');
    return db.transaction(async tx => {
      const r = await one(tx, 'SELECT * FROM operator_payout_requests WHERE id=$1 FOR UPDATE', [event.payoutRequestId]);
      invariant(r, 'NOT_FOUND', 'Operator payout request not found.', 404);
      invariant(r.provider === adapter?.name && r.amount_minor === (event.amountMinor ?? r.amount_minor) &&
        (event.currency === undefined || r.currency === event.currency), 'PAYOUT_MISMATCH', 'Provider payout does not match the request.', 409);
      invariant(!r.provider_reference || r.provider_reference === event.reference, 'PAYOUT_MISMATCH', 'Provider reference does not match.', 409);
      const hash = digest(event);
      const prior = await one(tx, 'SELECT fingerprint FROM operator_payout_events WHERE provider=$1 AND event_id=$2', [r.provider, event.eventId]);
      if (prior) { invariant(prior.fingerprint === hash, 'EVENT_CONFLICT', 'Event identifier was reused with different data.', 409); return publicRequest(r); }
      const allowed = { requested: [], processing: ['processing', 'paid', 'failed', 'cancelled'], paid: ['paid', 'reversed'], failed: ['failed', 'processing'], cancelled: ['cancelled'], reversed: ['reversed'] };
      invariant(allowed[r.status].includes(event.status), 'PAYOUT_TRANSITION', 'Payout event conflicts with its current state.', 409);
      const next = event.status === r.status ? r.status : event.status;
      if (event.status === 'paid') {
        await tx.query(`UPDATE operator_settlements SET payout_state='paid' WHERE payout_request_id=$1 AND payout_state='reserved'`, [r.id]);
      } else if (event.status === 'failed' || event.status === 'cancelled') {
        await release(tx, r.id);
      } else if (event.status === 'reversed') {
        await tx.query(`UPDATE operator_settlements SET payout_state='reversed' WHERE payout_request_id=$1 AND payout_state IN ('reserved','paid')`, [r.id]);
      }
      const result = await one(tx, 'UPDATE operator_payout_requests SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [r.id, next]);
      await tx.query('INSERT INTO operator_payout_events(provider,event_id,payout_request_id,fingerprint,status) VALUES($1,$2,$3,$4,$5)',
        [r.provider, event.eventId, r.id, hash, event.status]);
      await audit(tx, null, 'operator_payout.' + event.status, r.id, r.operator_id, { amountMinor: r.amount_minor });
      await emit(tx, 'operator_payout.' + event.status, r.id, { operatorId: r.operator_id, amountMinor: r.amount_minor });
      return publicRequest(result);
    });
  }
  return {
    configured: !!adapter,
    // Trusted credit entry: walk-up cash bookings and cash parcel collection
    // call this inside their own transactions.
    async credit(tx, input) {
      invariant(input && Object.keys(input).every(k => ['operatorId', 'source', 'reference', 'grossMinor', 'deductionMinor'].includes(k)),
        'INVALID_CREDIT', 'Unexpected credit fields.');
      uuid(input.operatorId);
      invariant(['walk_up', 'parcel_cash'].includes(input.source) && typeof input.reference === 'string' && input.reference.length > 0 && input.reference.length <= 150 &&
        Number.isInteger(input.grossMinor) && input.grossMinor > 0 &&
        (input.deductionMinor === undefined || (Number.isInteger(input.deductionMinor) && input.deductionMinor >= 0 && input.deductionMinor <= input.grossMinor)),
      'INVALID_CREDIT', 'Credit details are invalid.');
      const row = await one(tx, `INSERT INTO operator_settlements(operator_id,source,reference,gross_minor,deduction_minor)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [input.operatorId, input.source, input.reference, input.grossMinor, input.deductionMinor ?? 0]);
      await emit(tx, 'operator_settlement.credited', row.id, { operatorId: row.operator_id, grossMinor: row.gross_minor, source: row.source });
      return row;
    },
    async summary(actor) {
      return db.transaction(async tx => {
        const { operator } = await viewScope(tx, actor, actor.operator_id);
        const rows = (await tx.query(`SELECT payout_state,sum(net_minor)::integer AS total FROM operator_settlements
          WHERE operator_id=$1 AND (payout_state<>'available' OR available_at<=now()) GROUP BY payout_state`, [operator.id])).rows;
        const totals = { available: 0, reserved: 0, paid: 0, reversed: 0 };
        for (const row of rows) if (Object.hasOwn(totals, row.payout_state)) totals[row.payout_state] = row.total;
        return { ...totals, currency: 'XOF', verificationStatus: operator.verification_status };
      });
    },
    async ledger(actor) {
      return db.transaction(async tx => {
        const { operator } = await viewScope(tx, actor, actor.operator_id);
        return (await tx.query(`SELECT id,source,reference,gross_minor,deduction_minor,net_minor,currency,payout_state,payout_request_id,earned_at,available_at
          FROM operator_settlements WHERE operator_id=$1 ORDER BY earned_at DESC LIMIT 200`, [operator.id])).rows;
      });
    },
    async request(actor, input, key) {
      idempotencyKey(key);
      invariant(input && Object.keys(input).every(k => ['amountMinor', 'phoneNumber', 'country', 'network'].includes(k)),
        'INVALID_PAYOUT', 'Unexpected payout fields.');
      invariant(Number.isInteger(input.amountMinor) && input.amountMinor > 0, 'INVALID_PAYOUT', 'Amount must be a positive integer in minor units.');
      invariant(typeof input.phoneNumber === 'string' && /^[0-9]{8,15}$/.test(input.phoneNumber), 'INVALID_PAYOUT', 'A valid Mobile Money number is required.');
      invariant(typeof input.country === 'string' && /^[a-z]{2}$/i.test(input.country), 'INVALID_PAYOUT', 'Country is invalid.');
      invariant(input.network === undefined || input.network === null || (typeof input.network === 'string' && /^[a-z0-9-]{1,20}$/.test(input.network)), 'INVALID_PAYOUT', 'Network is invalid.');
      const fingerprint = digest([actor.id, input.amountMinor, input.phoneNumber, input.country]);
      const storedKey = 'operator-payout:' + actor.id + ':' + key;
      return db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [storedKey]);
        const { operator } = await withdrawScope(tx, actor, actor.operator_id);
        invariant(operator.verification_status === 'verified', 'OPERATOR_NOT_VERIFIED', 'Operator verification is required before withdrawals.', 403);
        const prior = await one(tx, 'SELECT * FROM operator_payout_requests WHERE idempotency_key=$1', [storedKey]);
        if (prior) { invariant(prior.request_fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Key was used for another request.', 409); return publicRequest(prior); }
        const row = await one(tx, `INSERT INTO operator_payout_requests(operator_id,amount_minor,currency,phone_number,country,network,provider,status,idempotency_key,request_fingerprint)
          VALUES($1,$2,'XOF',$3,$4,$5,$6,'requested',$7,$8) RETURNING *`,
        [operator.id, input.amountMinor, input.phoneNumber, input.country.toLowerCase(), input.network ?? null, adapter ? adapter.name : 'fedapay', storedKey, fingerprint]);
        await reserve(tx, operator.id, input.amountMinor, row.id);
        await audit(tx, actor.id, 'operator_payout.requested', row.id, operator.id, { amountMinor: input.amountMinor });
        await emit(tx, 'operator_payout.requested', row.id, { operatorId: operator.id, amountMinor: input.amountMinor });
        return publicRequest(row);
      });
    },
    async list(actor) {
      return db.transaction(async tx => {
        const { operator } = await viewScope(tx, actor, actor.operator_id);
        return (await tx.query('SELECT * FROM operator_payout_requests WHERE operator_id=$1 ORDER BY created_at DESC LIMIT 100', [operator.id])).rows.map(publicRequest);
      });
    },
    async approve(actor, id) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      const row = await db.transaction(async tx => {
        const r = await one(tx, 'SELECT * FROM operator_payout_requests WHERE id=$1 FOR UPDATE', [uuid(id)]);
        invariant(r, 'NOT_FOUND', 'Operator payout request not found.', 404);
        invariant(!actor.operator_id || actor.operator_id === r.operator_id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        invariant(['requested', 'failed'].includes(r.status), 'PAYOUT_TRANSITION', 'This withdrawal is not awaiting approval.', 409);
        if (r.status === 'failed') await reserve(tx, r.operator_id, r.amount_minor, r.id);
        const result = await one(tx, 'UPDATE operator_payout_requests SET status=$2,approved_by=$3,decided_at=now(),updated_at=now() WHERE id=$1 RETURNING *', [r.id, 'processing', actor.id]);
        await audit(tx, actor.id, 'operator_payout.approved', r.id, r.operator_id, { amountMinor: r.amount_minor });
        await emit(tx, 'operator_payout.processing', r.id, { operatorId: r.operator_id });
        return result;
      });
      const operator = await db.transaction(tx => one(tx, 'SELECT * FROM operators WHERE id=$1', [row.operator_id]));
      const owner = await db.transaction(tx => one(tx, 'SELECT display_name FROM users WHERE id=$1', [operator.owner_user_id]));
      try {
        invariant(adapter, 'PAYOUT_UNAVAILABLE', 'Le versement n’est pas encore configuré.', 503);
        const [firstName, ...rest] = (owner?.display_name || operator.name || 'Opérateur').split(/\s+/);
        const result = await adapter.createPayout({ payoutRequestId: row.id, firstName, lastName: rest.join(' ') || firstName,
          phoneNumber: row.phone_number, country: row.country, amountMinor: row.amount_minor, currency: row.currency, idempotencyKey: row.id });
        invariant(result && typeof result.reference === 'string' && result.reference.length > 0 && result.reference.length <= 150,
          'PAYOUT_UNAVAILABLE', 'Provider payout initiation was incomplete. Reconcile before retrying.', 503);
        const metadata = result.metadata && typeof result.metadata === 'object' ? result.metadata : {};
        return db.transaction(async tx => {
          const current = await one(tx, 'SELECT * FROM operator_payout_requests WHERE id=$1 FOR UPDATE', [row.id]);
          invariant(!current.provider_reference || current.provider_reference === result.reference, 'PAYOUT_MISMATCH', 'Provider returned another reference.', 409);
          return publicRequest(await one(tx, 'UPDATE operator_payout_requests SET provider_reference=$2,provider_metadata=$3,updated_at=now() WHERE id=$1 RETURNING *',
            [row.id, result.reference, JSON.stringify(metadata)]));
        });
      } catch (error) {
        await db.transaction(async tx => {
          const r = await one(tx, 'SELECT * FROM operator_payout_requests WHERE id=$1 FOR UPDATE', [row.id]);
          if (r.status === 'processing') {
            await release(tx, r.id);
            await one(tx, 'UPDATE operator_payout_requests SET status=$2,updated_at=now() WHERE id=$1', [r.id, 'failed']);
            await audit(tx, actor.id, 'operator_payout.failed', r.id, r.operator_id, { reason: 'provider_initiation' });
            await emit(tx, 'operator_payout.failed', r.id, { operatorId: r.operator_id });
          }
        });
        throw error;
      }
    },
    async cancel(actor, id) {
      return db.transaction(async tx => {
        const { operator } = await withdrawScope(tx, actor, actor.operator_id);
        const r = await one(tx, 'SELECT * FROM operator_payout_requests WHERE id=$1 AND operator_id=$2 FOR UPDATE', [uuid(id), operator.id]);
        invariant(r, 'NOT_FOUND', 'Operator payout request not found.', 404);
        invariant(r.status === 'requested', 'PAYOUT_TRANSITION', 'Only a pending withdrawal can be cancelled.', 409);
        await release(tx, r.id);
        const result = await one(tx, 'UPDATE operator_payout_requests SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [r.id, 'cancelled']);
        await audit(tx, actor.id, 'operator_payout.cancelled', r.id, operator.id);
        return publicRequest(result);
      });
    },
    async webhook(name, raw, headers) {
      invariant(adapter && name === adapter.name, 'PAYOUT_UNAVAILABLE', 'Payment integration is unavailable.', 503);
      const event = await adapter.verifyEvent(raw, headers);
      if (!event || event.kind !== 'payout') return { ignored: true };
      const { payoutRequestId, eventId, reference, amountMinor, currency, status } = event;
      return apply({ payoutRequestId, eventId, reference, amountMinor, currency, status });
    },
    applyEvent(event) {
      invariant(event?.kind === 'payout', 'INVALID_PAYOUT_EVENT', 'Not a payout event.');
      const { payoutRequestId, eventId, reference, amountMinor, currency, status } = event;
      return apply({ payoutRequestId, eventId, reference, amountMinor, currency, status });
    },
    async reconcile(actor, id) {
      uuid(id);
      return db.transaction(async tx => {
        const r = await one(tx, 'SELECT * FROM operator_payout_requests WHERE id=$1', [id]);
        invariant(r, 'NOT_FOUND', 'Operator payout request not found.', 404);
        if (actor?.role === 'ops') invariant(!actor.operator_id || actor.operator_id === r.operator_id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        else await viewScope(tx, actor, r.operator_id);
        invariant(adapter && r.provider === adapter.name, 'PAYOUT_UNAVAILABLE', 'Payment integration is unavailable.', 503);
        return r;
      }).then(async r => {
        const event = await adapter.reconcilePayout(r);
        if (!event) return { ignored: true };
        const { payoutRequestId, eventId, reference, amountMinor, currency, status } = event;
        return apply({ payoutRequestId, eventId, reference, amountMinor, currency, status });
      });
    },
    async listOps(actor) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      return db.transaction(async tx => (await tx.query(`SELECT r.*,o.name AS operator_name,o.type AS operator_type FROM operator_payout_requests r
        JOIN operators o ON o.id=r.operator_id WHERE ($1::uuid IS NULL OR r.operator_id=$1) ORDER BY r.created_at DESC LIMIT 100`, [actor.operator_id])).rows
        .map(r => ({ ...publicRequest(r), operatorName: r.operator_name, operatorType: r.operator_type })));
    },
  };
}
