import { createHash } from 'node:crypto';
import { invariant, uuid, idempotencyKey } from '@leroutier/domain';
import { audit } from './identities.js';

const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const emit = (tx, type, id, payload = {}) => tx.query(
  'INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)', [type, id, JSON.stringify(payload)]);

// ---------------------------------------------------------------------------
// Driver earnings ledger. Provider-independent; deliberately contains NO
// commission/revenue split: credits are only created through credit() and
// the business formula is configured later.
// ---------------------------------------------------------------------------
export function earnings(db) {
  async function driverActor(tx, actor) {
    invariant(actor?.role === 'driver', 'FORBIDDEN', 'Driver access required.', 403);
    const profile = await one(tx, 'SELECT * FROM driver_profiles WHERE user_id=$1 AND active=true', [actor.id]);
    invariant(profile, 'ACCOUNT_DISABLED', 'This driver account is inactive. Contact an administrator.', 403);
    return profile;
  }
  return {
    // Explicit domain interface for earning credits. Automated derivation from
    // platform activity is intentionally NOT wired yet: the commission formula
    // requires product configuration (test fixtures use this interface).
    async credit(input) {
      invariant(input && Object.keys(input).every(k => ['driverId', 'operatorId', 'source', 'reference', 'grossMinor', 'deductionMinor', 'currency', 'earnedAt', 'availableAt'].includes(k)), 'INVALID_EARNING', 'Unexpected earning fields.');
      uuid(input.driverId);
      invariant(input.operatorId === null || input.operatorId === undefined || typeof input.operatorId === 'string', 'INVALID_EARNING', 'Operator reference is invalid.');
      if (input.operatorId) uuid(input.operatorId);
      invariant(typeof input.source === 'string' && /^[a-z][a-z0-9_.-]{0,40}$/.test(input.source) &&
        typeof input.reference === 'string' && input.reference.length > 0 && input.reference.length <= 150 &&
        Number.isInteger(input.grossMinor) && input.grossMinor > 0 &&
        (input.deductionMinor === undefined || (Number.isInteger(input.deductionMinor) && input.deductionMinor >= 0 && input.deductionMinor <= input.grossMinor)) &&
        (input.currency === undefined || input.currency === 'XOF'), 'INVALID_EARNING', 'Earning details are invalid.');
      const deduction = input.deductionMinor ?? 0;
      const earnedAt = input.earnedAt ? new Date(input.earnedAt) : new Date();
      const availableAt = input.availableAt ? new Date(input.availableAt) : earnedAt;
      invariant(Number.isFinite(earnedAt.getTime()) && Number.isFinite(availableAt.getTime()) && availableAt >= earnedAt, 'INVALID_EARNING', 'Earning dates are invalid.');
      return db.transaction(async tx => {
        const row = await one(tx, `INSERT INTO driver_earnings(driver_id,operator_id,source,reference,gross_minor,deduction_minor,currency,earned_at,available_at)
          VALUES($1,$2,$3,$4,$5,$6,'XOF',$7,$8) RETURNING *`,
        [input.driverId, input.operatorId ?? null, input.source, input.reference, input.grossMinor, deduction, earnedAt, availableAt]);
        await emit(tx, 'earning.credited', row.id, { driverId: input.driverId, netMinor: row.net_minor });
        return row;
      });
    },
    async summary(actor) {
      invariant(actor?.role === 'driver', 'FORBIDDEN', 'Driver access required.', 403);
      return db.transaction(async tx => {
        await driverActor(tx, actor);
        const rows = (await tx.query(`SELECT payout_state,sum(net_minor)::integer AS total FROM driver_earnings
          WHERE driver_id=$1 AND (payout_state<>'available' OR available_at<=now()) GROUP BY payout_state`, [actor.id])).rows;
        const totals = { available: 0, reserved: 0, paid: 0, reversed: 0 };
        for (const row of rows) if (Object.hasOwn(totals, row.payout_state)) totals[row.payout_state] = row.total;
        return { ...totals, currency: 'XOF' };
      });
    },
    async ledger(actor) {
      invariant(actor?.role === 'driver', 'FORBIDDEN', 'Driver access required.', 403);
      return db.transaction(async tx => {
        await driverActor(tx, actor);
        return (await tx.query(`SELECT id,source,reference,gross_minor,deduction_minor,net_minor,currency,payout_state,payout_request_id,earned_at,available_at
          FROM driver_earnings WHERE driver_id=$1 ORDER BY earned_at DESC LIMIT 200`, [actor.id])).rows;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Driver payouts (withdrawals). The adapter is the provider-independent
// payment gateway interface (FedaPay Payouts in production). No caller other
// than a trusted provider result may mark a payout paid.
// ---------------------------------------------------------------------------
export function payouts(db, adapter = null, config = {}) {
  const approvalRequired = config.payoutApprovalRequired !== false;

  const publicRequest = r => ({ id: r.id, driverId: r.driver_id, destinationId: r.destination_id, amountMinor: r.amount_minor,
    currency: r.currency, provider: r.provider, providerReference: r.provider_reference, providerMetadata: r.provider_metadata,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, approvedBy: r.approved_by, decidedAt: r.decided_at });

  async function reserve(tx, driverId, amountMinor, requestId) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['payout-balance:' + driverId]);
    const { rows } = await tx.query(`SELECT id,net_minor,deduction_minor,driver_id,operator_id,source,reference,currency,earned_at,available_at
      FROM driver_earnings WHERE driver_id=$1 AND payout_state='available' AND available_at<=now()
      ORDER BY earned_at,id FOR UPDATE`, [driverId]);
    let need = amountMinor; const ids = [];
    for (const row of rows) {
      ids.push(row.id);
      if (row.net_minor <= need) { need -= row.net_minor; if (need === 0) break; continue; }
      // Partial reservation: the ledger stays append-only — the remainder is
      // split into a new available row, the reserved row keeps the deductions.
      const excess = row.net_minor - need;
      await tx.query(`INSERT INTO driver_earnings(driver_id,operator_id,source,reference,gross_minor,deduction_minor,currency,earned_at,available_at)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,$8)`,[row.driver_id,row.operator_id,row.source,'split:'+row.reference,excess,row.currency,row.earned_at,row.available_at]);
      await tx.query('UPDATE driver_earnings SET gross_minor=$2 WHERE id=$1',[row.id,need + row.deduction_minor]);
      need = 0; break;
    }
    invariant(need === 0, 'INSUFFICIENT_BALANCE', 'Le solde disponible ne couvre pas ce retrait.', 409);
    await tx.query('UPDATE driver_earnings SET payout_state=$2,payout_request_id=$3 WHERE id=ANY($1)', [ids, 'reserved', requestId]);
  }
  function release(tx, requestId) {
    return tx.query(`UPDATE driver_earnings SET payout_state='available',payout_request_id=NULL
      WHERE payout_request_id=$1 AND payout_state='reserved'`, [requestId]);
  }
  async function loadRequest(tx, id) {
    const row = await one(tx, 'SELECT * FROM payout_requests WHERE id=$1', [uuid(id)]);
    invariant(row, 'NOT_FOUND', 'Payout request not found.', 404);
    return row;
  }
  async function apply(event) {
    invariant(event && Object.keys(event).every(k => ['payoutRequestId', 'eventId', 'reference', 'amountMinor', 'currency', 'status'].includes(k)),
      'INVALID_PAYOUT_EVENT', 'Invalid payout event.');
    uuid(event.payoutRequestId);
    invariant(typeof event.eventId === 'string' && event.eventId.length > 0 && event.eventId.length <= 150 &&
      typeof event.reference === 'string' && event.reference.length > 0 && event.reference.length <= 150 &&
      (event.amountMinor === undefined || Number.isInteger(event.amountMinor)) &&
      (event.currency === undefined || event.currency === 'XOF') &&
      ['requested', 'processing', 'paid', 'failed', 'cancelled', 'reversed'].includes(event.status), 'INVALID_PAYOUT_EVENT', 'Invalid payout event.');
    return db.transaction(async tx => {
      const r = await one(tx, 'SELECT * FROM payout_requests WHERE id=$1 FOR UPDATE', [event.payoutRequestId]);
      invariant(r, 'NOT_FOUND', 'Payout request not found.', 404);
      invariant(r.provider === adapter?.name && r.amount_minor === (event.amountMinor ?? r.amount_minor) &&
        (event.currency === undefined || r.currency === event.currency),
        'PAYOUT_MISMATCH', 'Provider payout does not match the request.', 409);
      invariant(!r.provider_reference || r.provider_reference === event.reference, 'PAYOUT_MISMATCH', 'Provider reference does not match.', 409);
      const hash = digest(event);
      const prior = await one(tx, 'SELECT fingerprint FROM payout_events WHERE provider=$1 AND event_id=$2', [r.provider, event.eventId]);
      if (prior) { invariant(prior.fingerprint === hash, 'EVENT_CONFLICT', 'Event identifier was reused with different data.', 409); return publicRequest(r); }
      const allowed = { requested: [], processing: ['processing', 'paid', 'failed', 'cancelled'], paid: ['paid', 'reversed'], failed: ['failed', 'processing'], cancelled: ['cancelled'], reversed: ['reversed'] };
      invariant(allowed[r.status].includes(event.status), 'PAYOUT_TRANSITION', 'Payout event conflicts with its current state.', 409);
      const next = event.status === r.status ? r.status : event.status;
      if (event.status === 'processing' && !r.provider_reference) {
        await tx.query('UPDATE payout_requests SET provider_reference=$2,updated_at=now() WHERE id=$1', [r.id, event.reference]);
      }
      if (event.status === 'paid') {
        await tx.query(`UPDATE driver_earnings SET payout_state='paid' WHERE payout_request_id=$1 AND payout_state='reserved'`, [r.id]);
      } else if (event.status === 'failed' || event.status === 'cancelled') {
        await release(tx, r.id);
      } else if (event.status === 'reversed') {
        await tx.query(`UPDATE driver_earnings SET payout_state='reversed' WHERE payout_request_id=$1 AND payout_state IN ('reserved','paid')`, [r.id]);
      }
      const result = await one(tx, 'UPDATE payout_requests SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [r.id, next]);
      await tx.query('INSERT INTO payout_events(provider,event_id,payout_request_id,fingerprint,status) VALUES($1,$2,$3,$4,$5)',
        [r.provider, event.eventId, r.id, hash, event.status]);
      const profile = await one(tx, 'SELECT operator_id FROM driver_profiles WHERE user_id=$1', [r.driver_id]);
      await audit(tx, null, 'payout.' + event.status, r.id, profile?.operator_id ?? null, { payoutRequestId: r.id });
      await emit(tx, 'payout.' + event.status, r.id, { driverId: r.driver_id, amountMinor: r.amount_minor });
      return publicRequest(result);
    });
  }

  return {
    configured: !!adapter,
    // Internal accessor for the agentic layer; API routes enforce authorization.
    async getById(id) {
      const row = await db.transaction(tx => loadRequest(tx, id));
      const destination = await db.transaction(tx => one(tx, 'SELECT * FROM payout_destinations WHERE id=$1', [row.destination_id]));
      return { row, destination };
    },
    async destinations(actor) {
      invariant(actor?.role === 'driver', 'FORBIDDEN', 'Driver access required.', 403);
      return db.transaction(async tx => (await tx.query('SELECT id,country,network,phone_number AS "phoneNumber",verified,active,provider_beneficiary_ref AS "providerBeneficiaryRef" FROM payout_destinations WHERE driver_id=$1 ORDER BY created_at', [actor.id])).rows);
    },
    async addDestination(actor, input) {
      invariant(actor?.role === 'driver', 'FORBIDDEN', 'Driver access required.', 403);
      invariant(input && Object.keys(input).every(k => ['country', 'phoneNumber', 'network'].includes(k)), 'INVALID_DESTINATION', 'Unexpected destination fields.');
      invariant(typeof input.country === 'string' && /^[a-z]{2}$/i.test(input.country) &&
        typeof input.phoneNumber === 'string' && /^[0-9]{8,15}$/.test(input.phoneNumber) &&
        (input.network === undefined || input.network === null || (typeof input.network === 'string' && /^[a-z0-9-]{1,20}$/.test(input.network))),
      'INVALID_DESTINATION', 'Numéro ou pays invalide.');
      return db.transaction(async tx => {
        const profile = await one(tx, 'SELECT * FROM driver_profiles WHERE user_id=$1 AND active=true', [actor.id]);
        invariant(profile, 'ACCOUNT_DISABLED', 'This driver account is inactive. Contact an administrator.', 403);
        const row = await one(tx, `INSERT INTO payout_destinations(driver_id,country,network,phone_number) VALUES($1,$2,$3,$4)
          ON CONFLICT(driver_id,phone_number) DO UPDATE SET active=true,network=EXCLUDED.network RETURNING id,country,network,phone_number AS "phoneNumber",verified,active`,
        [actor.id, input.country.toLowerCase(), input.network ?? null, input.phoneNumber]);
        await audit(tx, actor.id, 'payout.destination_added', row.id, profile.operator_id, { driverId: actor.id });
        return row;
      });
    },
    async request(actor, input, key) {
      invariant(actor?.role === 'driver', 'FORBIDDEN', 'Driver access required.', 403);
      idempotencyKey(key); uuid(input.destinationId);
      invariant(Number.isInteger(input.amountMinor) && input.amountMinor > 0, 'INVALID_PAYOUT', 'Amount must be a positive integer in minor units.');
      if (config.payoutMinMinor !== undefined) invariant(input.amountMinor >= config.payoutMinMinor, 'PAYOUT_BELOW_MINIMUM', `Le retrait minimum est de ${config.payoutMinMinor} FCFA.`, 409);
      if (config.payoutMaxMinor !== undefined) invariant(input.amountMinor <= config.payoutMaxMinor, 'PAYOUT_ABOVE_MAXIMUM', `Le retrait maximum est de ${config.payoutMaxMinor} FCFA.`, 409);
      const fingerprint = digest([actor.id, input.destinationId, input.amountMinor]);
      const storedKey = 'payout:' + actor.id + ':' + key;
      return db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [storedKey]);
        const profile = await one(tx, 'SELECT * FROM driver_profiles WHERE user_id=$1 AND active=true', [actor.id]);
        invariant(profile, 'ACCOUNT_DISABLED', 'This driver account is inactive. Contact an administrator.', 403);
        const prior = await one(tx, 'SELECT * FROM payout_requests WHERE idempotency_key=$1', [storedKey]);
        if (prior) { invariant(prior.request_fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Key was used for another request.', 409); return publicRequest(prior); }
        const destination = await one(tx, 'SELECT * FROM payout_destinations WHERE id=$1 AND driver_id=$2 AND active=true FOR UPDATE', [input.destinationId, actor.id]);
        invariant(destination, 'INVALID_DESTINATION', 'Cette destination de versement ne vous appartient pas.', 409);
        const row = await one(tx, `INSERT INTO payout_requests(driver_id,destination_id,amount_minor,currency,provider,status,idempotency_key,request_fingerprint)
          VALUES($1,$2,$3,'XOF',$4,'requested',$5,$6) RETURNING *`,
        [actor.id, input.destinationId, input.amountMinor, adapter ? adapter.name : 'fedapay', storedKey, fingerprint]);
        await reserve(tx, actor.id, input.amountMinor, row.id);
        await audit(tx, actor.id, 'payout.requested', row.id, profile.operator_id, { amountMinor: input.amountMinor });
        await emit(tx, 'payout.requested', row.id, { driverId: actor.id, amountMinor: input.amountMinor, payoutRequestId: row.id });
        return publicRequest(row);
      });
    },
    async list(actor) {
      invariant(actor?.role === 'driver', 'FORBIDDEN', 'Driver access required.', 403);
      return db.transaction(async tx => (await tx.query('SELECT * FROM payout_requests WHERE driver_id=$1 ORDER BY created_at DESC LIMIT 100', [actor.id])).rows.map(publicRequest));
    },
    async cancel(actor, id) {
      invariant(actor?.role === 'driver', 'FORBIDDEN', 'Driver access required.', 403);
      return db.transaction(async tx => {
        const r = await one(tx, 'SELECT * FROM payout_requests WHERE id=$1 AND driver_id=$2 FOR UPDATE', [uuid(id), actor.id]);
        invariant(r, 'NOT_FOUND', 'Payout request not found.', 404);
        invariant(r.status === 'requested', 'PAYOUT_TRANSITION', 'Only a pending withdrawal can be cancelled.', 409);
        await release(tx, r.id);
        const result = await one(tx, 'UPDATE payout_requests SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [r.id, 'cancelled']);
        await audit(tx, actor.id, 'payout.cancelled', r.id, null, { driverId: actor.id });
        await emit(tx, 'payout.cancelled', r.id, { driverId: actor.id });
        return publicRequest(result);
      });
    },
    // Ops approval. When approval is not configured (documented pre-approved
    // policy), an authorised Ops call still triggers execution explicitly —
    // nothing is executed without an authorised actor.
    async approve(actor, id) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      const row = await db.transaction(async tx => {
        const r = await one(tx, 'SELECT * FROM payout_requests WHERE id=$1 FOR UPDATE', [uuid(id)]);
        invariant(r, 'NOT_FOUND', 'Payout request not found.', 404);
        const profile = await one(tx, 'SELECT operator_id FROM driver_profiles WHERE user_id=$1', [r.driver_id]);
        invariant(!actor.operator_id || actor.operator_id === profile?.operator_id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        invariant(['requested', 'failed'].includes(r.status), 'PAYOUT_TRANSITION', 'This withdrawal is not awaiting approval.', 409);
        if (r.status === 'failed') await reserve(tx, r.driver_id, r.amount_minor, r.id);
        const result = await one(tx, 'UPDATE payout_requests SET status=$2,approved_by=$3,decided_at=now(),updated_at=now() WHERE id=$1 RETURNING *', [r.id, 'processing', actor.id]);
        await audit(tx, actor.id, 'payout.approved', r.id, profile?.operator_id ?? null, { driverId: r.driver_id, approvalRequired });
        await emit(tx, 'payout.processing', r.id, { driverId: r.driver_id, approvedBy: actor.id });
        return result;
      });
      // Provider I/O happens outside DB locks; failure releases the reservation.
      const destination = await db.transaction(tx => one(tx, 'SELECT * FROM payout_destinations WHERE id=$1', [row.destination_id]));
      const driver = await db.transaction(tx => one(tx, 'SELECT display_name FROM users WHERE id=$1', [row.driver_id]));
      try {
        invariant(adapter, 'PAYOUT_UNAVAILABLE', 'Le versement des gains n’est pas encore configuré.', 503);
        const [firstName, ...rest] = (driver.display_name || 'Conducteur').split(/\s+/);
        const result = await adapter.createPayout({ payoutRequestId: row.id, firstName, lastName: rest.join(' ') || firstName,
          phoneNumber: destination.phone_number, country: destination.country, amountMinor: row.amount_minor, currency: row.currency, idempotencyKey: row.id });
        invariant(result && typeof result.reference === 'string' && result.reference.length > 0 && result.reference.length <= 150,
          'PAYOUT_UNAVAILABLE', 'Provider payout initiation was incomplete. Reconcile before retrying.', 503);
        const metadata = result.metadata && typeof result.metadata === 'object' ? result.metadata : {};
        return db.transaction(async tx => {
          const current = await one(tx, 'SELECT * FROM payout_requests WHERE id=$1 FOR UPDATE', [row.id]);
          invariant(!current.provider_reference || current.provider_reference === result.reference, 'PAYOUT_MISMATCH', 'Provider returned another reference.', 409);
          return publicRequest(await one(tx, 'UPDATE payout_requests SET provider_reference=$2,provider_metadata=$3,updated_at=now() WHERE id=$1 RETURNING *',
            [row.id, result.reference, JSON.stringify(metadata)]));
        });
      } catch (error) {
        await db.transaction(async tx => {
          const r = await one(tx, 'SELECT * FROM payout_requests WHERE id=$1 FOR UPDATE', [row.id]);
          if (r.status === 'processing') {
            await release(tx, r.id);
            await one(tx, 'UPDATE payout_requests SET status=$2,updated_at=now() WHERE id=$1', [r.id, 'failed']);
            await audit(tx, actor.id, 'payout.failed', r.id, null, { driverId: r.driver_id, reason: 'provider_initiation' });
            await emit(tx, 'payout.failed', r.id, { driverId: r.driver_id });
          }
        });
        throw error;
      }
    },
    async webhook(name, raw, headers) {
      invariant(adapter && name === adapter.name, 'PAYOUT_UNAVAILABLE', 'Payment integration is unavailable.', 503);
      const event = await adapter.verifyEvent(raw, headers);
      if (!event || event.kind !== 'payout') return { ignored: true };
      const { payoutRequestId, eventId, reference, amountMinor, currency, status } = event;
      return apply({ payoutRequestId, eventId, reference, amountMinor, currency, status });
    },
    // Apply an already-verified payout event (shared webhook route).
    applyEvent(event) {
      invariant(event?.kind === 'payout', 'INVALID_PAYOUT_EVENT', 'Not a payout event.');
      const { payoutRequestId, eventId, reference, amountMinor, currency, status } = event;
      return apply({ payoutRequestId, eventId, reference, amountMinor, currency, status });
    },
    async reconcile(actor, id) {
      uuid(id);
      return db.transaction(async tx => {
        const r = await one(tx, 'SELECT * FROM payout_requests WHERE id=$1', [id]);
        invariant(r, 'NOT_FOUND', 'Payout request not found.', 404);
        if (actor?.role === 'driver') invariant(r.driver_id === actor.id, 'FORBIDDEN', 'Payout request is not yours.', 403);
        else if (actor?.role === 'ops') {
          const profile = await one(tx, 'SELECT operator_id FROM driver_profiles WHERE user_id=$1', [r.driver_id]);
          invariant(!actor.operator_id || actor.operator_id === profile?.operator_id, 'FORBIDDEN', 'Operation is not permitted.', 403);
        } else invariant(false, 'FORBIDDEN', 'Crew access required.', 403);
        invariant(adapter && r.provider === adapter.name, 'PAYOUT_UNAVAILABLE', 'Payment integration is unavailable.', 503);
        return r;
      }).then(async r => {
        const event = await adapter.reconcilePayout(r);
        if (!event) return { ignored: true };
        const { payoutRequestId, eventId, reference, amountMinor, currency, status } = event;
        return apply({ payoutRequestId, eventId, reference, amountMinor, currency, status });
      });
    },
    async listOps(actor, filter = {}) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      const status = filter.status;
      invariant(status === undefined || ['requested', 'processing', 'paid', 'failed', 'cancelled', 'reversed'].includes(status), 'INVALID_STATUS', 'Invalid payout status.');
      return db.transaction(async tx => (await tx.query(`SELECT r.*,u.display_name AS driver_name,d.phone_number AS destination_phone FROM payout_requests r
        JOIN users u ON u.id=r.driver_id JOIN payout_destinations d ON d.id=r.destination_id
        WHERE ($1::text IS NULL OR r.status=$1) AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM driver_profiles dp WHERE dp.user_id=r.driver_id AND dp.operator_id=$2))
        ORDER BY r.created_at DESC LIMIT 100`, [status ?? null, actor.operator_id])).rows
        .map(r => ({ ...publicRequest(r), driverName: r.driver_name, destinationPhone: r.destination_phone })));
    },
    approvalRequired: () => approvalRequired,
  };
}
