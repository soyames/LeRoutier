import { createHash } from 'node:crypto';
import { invariant, uuid, idempotencyKey, priorBeninMonth } from '@leroutier/domain';
import { audit, activeIdentity } from './identities.js';
import { requirePlatform } from './platform-access.js';

// Operator revenue ledger. Revenue belongs to the OPERATOR: passenger and
// parcel payments flow through the service to the operator's settlement
// ledger. Independent owner-drivers and a company's registered owner/admin can
// request settlements; company drivers, convoyeurs and cashiers never can.
// Credits are created from trusted recorded activity only.
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const emit = (tx, type, id, payload = {}) => tx.query(
  'INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)', [type, id, JSON.stringify(payload)]);

export function operatorSettlements(db, adapter = null) {
  const publicRequest = r => ({ id: r.id, operatorId: r.operator_id, amountMinor: r.amount_minor, currency: r.currency,
    phoneNumber: r.phone_number, country: r.country, network: r.network, provider: r.provider, providerReference: r.provider_reference,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, approvedBy: r.approved_by, decidedAt: r.decided_at,
    payoutKind:r.payout_kind??'manual',payoutPeriod:r.payout_period??null,debtOffsetMinor:r.debt_offset_minor??0 });

  async function capability() {
    if (!adapter?.payoutsAvailable) return {state:'unavailable',canRequest:false,manualReconciliation:true};
    const proof=await db.transaction(tx=>one(tx,`SELECT id FROM operator_payout_requests WHERE provider=$1 AND status='paid'
      AND provider_metadata->>'verifiedEnvironment'=$2 AND provider_metadata->>'verifiedAccount'=$3 LIMIT 1`,[adapter.name,adapter.environment??'unknown',adapter.payoutAccount??'fixture']));
    return {state:proof?'available':'unproven',canRequest:!!proof,manualReconciliation:true};
  }
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
  // Withdrawal scope: an independent owner-driver, or the registered owner of
  // a verified company, may request a settlement. Platform Ops still approves
  // the actual transfer; company crew and cashiers cannot withdraw.
  async function withdrawScope(tx, actor, operatorId) {
    const user = await activeIdentity(tx, actor.id);
    const operator = await one(tx, 'SELECT * FROM operators WHERE id=$1', [operatorId]);
    invariant(operator, 'NOT_FOUND', 'Operator not found.', 404);
    const independentOwner=operator.owner_user_id===user.id&&operator.type==='independent'&&user.role==='driver';
    const companyOwner=(operator.owner_user_id===user.id||operator.admin_user_id===user.id)&&operator.type==='company'&&user.role==='ops';
    invariant(independentOwner||companyOwner,
      'FORBIDDEN', 'Seul le titulaire de l’opérateur peut demander un règlement.', 403);
    return { user, operator };
  }
  async function reserve(tx, operatorId, amountMinor, requestId, period = null) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['operator-balance:' + operatorId]);
    const { rows } = await tx.query(`SELECT id,net_minor,deduction_minor,operator_id,source,reference,currency,earned_at,available_at
      FROM operator_settlements WHERE operator_id=$1 AND payout_state='available' AND available_at<=now() AND source NOT IN ('walk_up','parcel_cash')
      AND NOT EXISTS(SELECT 1 FROM payments p WHERE operator_settlements.reference='payment:'||p.id::text AND p.reconciliation='review')
      AND ($2::timestamptz IS NULL OR (earned_at >= $2 AND earned_at < $3))
      ORDER BY earned_at,id FOR UPDATE`, [operatorId,period?.start??null,period?.end??null]);
    let need = amountMinor; const ids = [];
    for (const row of rows) {
      ids.push(row.id);
      if (row.net_minor <= need) { need -= row.net_minor; if (need === 0) break; continue; }
      const excess = row.net_minor - need;
      await tx.query(`INSERT INTO operator_settlements(operator_id,source,reference,gross_minor,deduction_minor,currency,earned_at,available_at)
        VALUES($1,$2,$3,$4,0,$5,$6,$7)`,[row.operator_id,row.source,'split:'+row.reference+':'+requestId,excess,row.currency,row.earned_at,row.available_at]);
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
  async function allocateReversals(tx, operatorId, amountMinor, requestId) {
    let remaining=amountMinor;
    const rows=(await tx.query(`SELECT id,amount_minor,settled_minor FROM operator_settlement_reversals
      WHERE operator_id=$1 AND state='open' ORDER BY created_at,id FOR UPDATE`,[operatorId])).rows;
    for(const row of rows){
      if(!remaining)break;
      const amount=Math.min(remaining,row.amount_minor-row.settled_minor);
      if(amount<=0)continue;
      await tx.query(`UPDATE operator_settlement_reversals SET state='allocated',allocated_minor=$2,payout_request_id=$3 WHERE id=$1`,
        [row.id,amount,requestId]);
      await tx.query(`INSERT INTO operator_reversal_allocations(payout_request_id,reversal_id,amount_minor)
        VALUES($1,$2,$3) ON CONFLICT(payout_request_id,reversal_id) DO UPDATE SET amount_minor=$3,state='allocated',settled_at=NULL`,[requestId,row.id,amount]);
      remaining-=amount;
    }
    invariant(remaining===0,'SETTLEMENT_REVERSAL_MISMATCH','Reversal balance changed while preparing the payout.',409);
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
      if(['paid','reversed'].includes(event.status))invariant(event.amountMinor===r.amount_minor && event.currency===r.currency,'PAYOUT_MISMATCH','Confirmed money movement requires the actual amount and currency.',409);
      invariant(!r.provider_reference || r.provider_reference === event.reference, 'PAYOUT_MISMATCH', 'Provider reference does not match.', 409);
      const hash = digest(event);
      const prior = await one(tx, 'SELECT fingerprint FROM operator_payout_events WHERE provider=$1 AND event_id=$2', [r.provider, event.eventId]);
      if (prior) { invariant(prior.fingerprint === hash, 'EVENT_CONFLICT', 'Event identifier was reused with different data.', 409); return publicRequest(r); }
      const allowed = { requested: [], processing: ['processing', 'paid', 'failed', 'cancelled'], paid: ['paid', 'reversed'], failed: ['failed'], cancelled: ['cancelled'], reversed: ['reversed'] };
      invariant(allowed[r.status].includes(event.status), 'PAYOUT_TRANSITION', 'Payout event conflicts with its current state.', 409);
      const next = event.status === r.status ? r.status : event.status;
      if (event.status === 'paid') {
        await tx.query(`UPDATE operator_settlements SET payout_state='paid' WHERE payout_request_id=$1 AND payout_state='reserved'`, [r.id]);
        await tx.query(`UPDATE operator_settlement_reversals SET settled_minor=settled_minor+allocated_minor,
          allocated_minor=0,state=CASE WHEN settled_minor+allocated_minor=amount_minor THEN 'settled' ELSE 'open' END,
          payout_request_id=NULL,settled_at=CASE WHEN settled_minor+allocated_minor=amount_minor THEN now() ELSE settled_at END
          WHERE payout_request_id=$1 AND state='allocated' AND allocated_minor>0`,[r.id]);
        await tx.query(`UPDATE operator_settlement_reversals SET state='open',payout_request_id=NULL
          WHERE payout_request_id=$1 AND state='allocated' AND allocated_minor=0`,[r.id]);
        await tx.query(`UPDATE operator_reversal_allocations SET state='settled',settled_at=now()
          WHERE payout_request_id=$1 AND state='allocated'`,[r.id]);
      } else if (event.status === 'failed' || event.status === 'cancelled') {
        await release(tx, r.id);
        await tx.query(`UPDATE operator_settlement_reversals SET state='open',payout_request_id=NULL
          WHERE payout_request_id=$1 AND state='allocated'`,[r.id]);
        await tx.query(`UPDATE operator_reversal_allocations SET state='released' WHERE payout_request_id=$1 AND state='allocated'`,[r.id]);
      } else if (event.status === 'reversed') {
        await tx.query(`UPDATE operator_settlements SET payout_state='reversed' WHERE payout_request_id=$1 AND payout_state IN ('reserved','paid')`, [r.id]);
        await tx.query(`UPDATE operator_settlement_reversals rev SET settled_minor=rev.settled_minor-alloc.amount_minor,
          state='open',settled_at=NULL FROM operator_reversal_allocations alloc
          WHERE alloc.payout_request_id=$1 AND alloc.reversal_id=rev.id AND alloc.state='settled'`,[r.id]);
        await tx.query(`UPDATE operator_reversal_allocations SET state='reversed' WHERE payout_request_id=$1 AND state='settled'`,[r.id]);
      }
      if(event.status==='paid') await tx.query("UPDATE operator_payout_requests SET provider_metadata=provider_metadata || jsonb_build_object('verifiedEnvironment',$2::text,'verifiedAccount',$3::text) WHERE id=$1",[r.id,adapter.environment??'unknown',adapter.payoutAccount??'fixture']);
      if(event.status==='failed') await tx.query("UPDATE operator_payout_requests SET provider_metadata=provider_metadata || '{\"confirmedFailure\":true}' WHERE id=$1",[r.id]);
      const result = await one(tx, 'UPDATE operator_payout_requests SET status=$2,provider_reference=COALESCE(provider_reference,$3),updated_at=now() WHERE id=$1 RETURNING *', [r.id, next,event.reference]);
      await tx.query('INSERT INTO operator_payout_events(provider,event_id,payout_request_id,fingerprint,status) VALUES($1,$2,$3,$4,$5)',
        [r.provider, event.eventId, r.id, hash, event.status]);
      await audit(tx, null, 'operator_payout.' + event.status, r.id, r.operator_id, { amountMinor: r.amount_minor });
      await emit(tx, 'operator_payout.' + event.status, r.id, { operatorId: r.operator_id, amountMinor: r.amount_minor });
      return publicRequest(result);
    });
  }
  return {
    configured: !!adapter,
    capability,
    async cashFees(actor) {
      requirePlatform(actor,'finance');
      return db.transaction(async tx => (await tx.query(`SELECT f.*,o.name AS operator_name FROM operator_cash_fees f
        JOIN operators o ON o.id=f.operator_id ORDER BY f.created_at DESC LIMIT 200`)).rows);
    },
    async collectCashFee(actor,id,input) {
      return db.transaction(async tx => {
        requirePlatform(await activeIdentity(tx,actor.id),'finance');
        invariant(input && Number.isInteger(input.amountMinor) && input.amountMinor>0 && typeof input.reference==='string' && input.reference.length>=8 && input.reference.length<=150,'INVALID_COLLECTION','Montant et référence confirmée requis.');
        const fee=await one(tx,'SELECT * FROM operator_cash_fees WHERE id=$1 FOR UPDATE',[uuid(id)]);
        invariant(fee,'NOT_FOUND','Frais introuvables.',404);
        const prior=await one(tx,'SELECT * FROM operator_cash_fee_collections WHERE reference=$1',[input.reference]);
        if(prior){invariant(prior.cash_fee_id===id&&prior.amount_minor===input.amountMinor,'IDEMPOTENCY_CONFLICT','Référence déjà utilisée.',409);return prior;}
        invariant(input.amountMinor<=fee.fee_minor-fee.collected_minor,'INVALID_COLLECTION','Montant supérieur aux frais dus.',409);
        const receipt=await one(tx,'INSERT INTO operator_cash_fee_collections(cash_fee_id,amount_minor,reference,recorded_by) VALUES($1,$2,$3,$4) RETURNING *',[id,input.amountMinor,input.reference,actor.id]);
        await tx.query('UPDATE operator_cash_fees SET collected_minor=collected_minor+$2 WHERE id=$1',[id,input.amountMinor]);
        await audit(tx,actor.id,'cash_fee.collected',id,fee.operator_id,{amountMinor:input.amountMinor,reference:input.reference});
        return receipt;
      });
    },
    async manualSettlement(actor,id,input) {
      return db.transaction(async tx => {
        requirePlatform(await activeIdentity(tx,actor.id),'finance');
        invariant(input && typeof input.reference==='string' && input.reference.length>=8 && input.reference.length<=150 &&
          typeof input.confirmation==='string' && input.confirmation.length>=10 && input.confirmation.length<=500 && Number.isInteger(input.confirmedAmountMinor),'INVALID_PAYOUT','Référence bancaire et confirmation requises.');
        const r=await one(tx,'SELECT * FROM operator_payout_requests WHERE id=$1 FOR UPDATE',[uuid(id)]);
        invariant(r,'NOT_FOUND','Règlement introuvable.',404);
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['manual-bank-reference:'+input.reference]);
        invariant(!await one(tx,'SELECT id FROM operator_payout_requests WHERE provider_reference=$1 AND id<>$2',['manual:'+input.reference,id]),'IDEMPOTENCY_CONFLICT','Cette référence bancaire a déjà réglé une autre demande.',409);
        if(r.status==='paid'&&r.provider_metadata.manual){invariant(r.provider_reference==='manual:'+input.reference&&r.amount_minor===input.confirmedAmountMinor,'IDEMPOTENCY_CONFLICT','Autre règlement enregistré.',409);return publicRequest(r);}
        const failed=r.status==='failed'&&r.provider_metadata.confirmedFailure===true;
        invariant(failed || (r.status==='requested'&&!r.provider_reference&&!r.provider_metadata.fedapayId),'PAYOUT_RECONCILE_REQUIRED','Réconciliez tout versement prestataire avant un règlement manuel.',409);
        invariant(r.amount_minor===input.confirmedAmountMinor,'PAYOUT_MISMATCH','Montant confirmé différent.',409);
        if(failed){
          const period=r.payout_period?priorBeninMonth(new Date(new Date(r.payout_period).getTime()+32*86400000)):null;
          await reserve(tx,r.operator_id,r.amount_minor+(r.debt_offset_minor??0),r.id,period);
          if(r.debt_offset_minor)await allocateReversals(tx,r.operator_id,r.debt_offset_minor,r.id);
        }
        await tx.query("UPDATE operator_settlements SET payout_state='paid' WHERE payout_request_id=$1 AND payout_state='reserved'",[id]);
        await tx.query(`UPDATE operator_settlement_reversals SET settled_minor=settled_minor+allocated_minor,allocated_minor=0,
          state=CASE WHEN settled_minor+allocated_minor=amount_minor THEN 'settled' ELSE 'open' END,payout_request_id=NULL
          WHERE payout_request_id=$1 AND state='allocated'`,[id]);
        await tx.query("UPDATE operator_reversal_allocations SET state='settled',settled_at=now() WHERE payout_request_id=$1 AND state='allocated'",[id]);
        const updated=await one(tx,`UPDATE operator_payout_requests SET status='paid',provider_reference=$2,
          provider_metadata=jsonb_build_object('manual',true,'confirmation',$3::text),approved_by=$4,decided_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[id,'manual:'+input.reference,input.confirmation,actor.id]);
        await audit(tx,actor.id,'operator_payout.manual_confirmed',id,r.operator_id,{amountMinor:r.amount_minor,reference:input.reference,confirmation:input.confirmation,previousProviderReference:r.provider_reference});
        return publicRequest(updated);
      });
    },
    // Trusted credit entry: walk-up cash bookings and cash parcel collection
    // call this inside their own transactions.
    async credit(tx, input) {
      invariant(input && Object.keys(input).every(k => ['operatorId', 'source', 'reference', 'grossMinor', 'deductionMinor','payoutState'].includes(k)),
        'INVALID_CREDIT', 'Unexpected credit fields.');
      uuid(input.operatorId);
      invariant(['walk_up', 'parcel_cash', 'ticket_online', 'parcel_online'].includes(input.source) && typeof input.reference === 'string' && input.reference.length > 0 && input.reference.length <= 150 &&
        Number.isInteger(input.grossMinor) && input.grossMinor > 0 &&
        (input.deductionMinor === undefined || (Number.isInteger(input.deductionMinor) && input.deductionMinor >= 0 && input.deductionMinor <= input.grossMinor)) &&
        (input.payoutState===undefined||input.payoutState==='direct'),
      'INVALID_CREDIT', 'Credit details are invalid.');
      // One (source,reference) credits once: a replayed provider event or a
      // repeated cash entry can never credit the operator twice. The replay
      // must also be *quiet*: reading `row.id` off the skipped insert threw a
      // TypeError, which rolled the caller's whole transaction back and
      // answered a duplicate webhook with a 503 instead of an acknowledgement
      // — the exact shape that makes a provider retry forever.
      const row = await one(tx, `INSERT INTO operator_settlements(operator_id,source,reference,gross_minor,deduction_minor,payout_state)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (operator_id,source,reference) DO NOTHING RETURNING *`, [input.operatorId, input.source, input.reference, input.grossMinor, input.deductionMinor ?? 0,input.payoutState??(['walk_up','parcel_cash'].includes(input.source)?'direct':'available')]);
      if (!row) return await one(tx, 'SELECT * FROM operator_settlements WHERE operator_id=$1 AND source=$2 AND reference=$3',
        [input.operatorId, input.source, input.reference]);
      await emit(tx, 'operator_settlement.credited', row.id, { operatorId: row.operator_id, grossMinor: row.gross_minor, source: row.source });
      return row;
    },
    async summary(actor) {
      return db.transaction(async tx => {
        const { operator } = await viewScope(tx, actor, actor.operator_id);
        const rows = (await tx.query(`SELECT payout_state,sum(net_minor)::integer AS total FROM operator_settlements
          WHERE operator_id=$1 AND (payout_state<>'available' OR available_at<=now()) GROUP BY payout_state`, [operator.id])).rows;
        const totals = { available: 0, reserved: 0, paid: 0, reversed: 0, direct:0 };
        for (const row of rows) if (Object.hasOwn(totals, row.payout_state)) totals[row.payout_state] = row.total;
        const debt=await one(tx,"SELECT coalesce(sum(amount_minor-settled_minor),0)::integer AS total FROM operator_settlement_reversals WHERE operator_id=$1 AND state IN ('open','allocated')",[operator.id]);
        const cashSales=(await tx.query('SELECT * FROM operator_cash_fees WHERE operator_id=$1 ORDER BY created_at DESC LIMIT 200',[operator.id])).rows;
        return { ...totals, cashSales, outstandingReversals:debt.total, currency: 'XOF', verificationStatus: operator.verification_status };
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
        const debt=await one(tx,"SELECT id FROM operator_settlement_reversals WHERE operator_id=$1 AND state IN ('open','allocated') LIMIT 1",[operator.id]);
        invariant(!debt,'SETTLEMENT_REVERSAL_PENDING','Un remboursement doit être compensé avant un retrait manuel. Le règlement mensuel compensera automatiquement ce montant.',409);
        const row = await one(tx, `INSERT INTO operator_payout_requests(operator_id,amount_minor,currency,phone_number,country,network,provider,status,idempotency_key,request_fingerprint)
          VALUES($1,$2,'XOF',$3,$4,$5,$6,'requested',$7,$8) RETURNING *`,
        [operator.id, input.amountMinor, input.phoneNumber, input.country.toLowerCase(), input.network ?? null, adapter ? adapter.name : 'fedapay', storedKey, fingerprint]);
        await reserve(tx, operator.id, input.amountMinor, row.id);
        await audit(tx, actor.id, 'operator_payout.requested', row.id, operator.id, { amountMinor: input.amountMinor });
        await emit(tx, 'operator_payout.requested', row.id, { operatorId: operator.id, amountMinor: input.amountMinor });
        return publicRequest(row);
      });
    },
    async payoutSchedule(actor) {
      return db.transaction(async tx=>{
        const {operator}=await withdrawScope(tx,actor,actor.operator_id);
        const schedule=await one(tx,'SELECT enabled,consent_version,phone_number AS "phoneNumber",country,network,consented_at AS "consentedAt" FROM operator_payout_schedules WHERE operator_id=$1',[operator.id]);
        return {enabled:!!(schedule?.enabled&&schedule.consent_version==='monthly-v1'),phoneNumber:schedule?.phoneNumber??'',country:schedule?.country??'BJ',network:schedule?.network??null,consentedAt:schedule?.consentedAt??null,available:(await capability()).canRequest};
      });
    },
    async setPayoutSchedule(actor,input) {
      invariant(input&&Object.keys(input).every(k=>['enabled','phoneNumber','country','network','consentVersion'].includes(k))&&typeof input.enabled==='boolean'&&input.consentVersion==='monthly-v1',
        'INVALID_PAYOUT_SCHEDULE','Paramètres de versement automatique invalides.');
      invariant(typeof input.phoneNumber==='string'&&/^[0-9]{8,15}$/.test(input.phoneNumber)&&
        typeof input.country==='string'&&/^[a-z]{2}$/i.test(input.country)&&
        (input.network===undefined||input.network===null||typeof input.network==='string'&&/^[a-z0-9-]{1,20}$/i.test(input.network)),
      'INVALID_PAYOUT_SCHEDULE','Destination Mobile Money invalide.');
      return db.transaction(async tx=>{
        const {user,operator}=await withdrawScope(tx,actor,actor.operator_id);
        invariant(operator.verification_status==='verified','OPERATOR_NOT_VERIFIED','La vérification de l’opérateur est requise.',403);
        const row=await one(tx,`INSERT INTO operator_payout_schedules(operator_id,enabled,phone_number,country,network,consented_by,consent_version)
          VALUES($1,$2,$3,$4,$5,$6,'monthly-v1') ON CONFLICT(operator_id) DO UPDATE SET enabled=EXCLUDED.enabled,phone_number=EXCLUDED.phone_number,
            country=EXCLUDED.country,network=EXCLUDED.network,consented_by=EXCLUDED.consented_by,consented_at=now(),updated_at=now(),consent_version='monthly-v1'
          RETURNING enabled,phone_number AS "phoneNumber",country,network,consented_at AS "consentedAt"`,
        [operator.id,input.enabled,input.phoneNumber,input.country.toLowerCase(),input.network??null,user.id]);
        await audit(tx,user.id,input.enabled?'operator.monthly_payout_enabled':'operator.monthly_payout_disabled',operator.id,operator.id,
          {country:row.country,network:row.network});
        return {...row,available:(await capability()).canRequest};
      });
    },
    async runMonthly(periodValue = null) {
      const support=await capability();
      const asOf=periodValue?new Date(`${periodValue}T00:00:00+01:00`):new Date();
      invariant(!Number.isNaN(asOf.getTime()),'INVALID_PAYOUT_PERIOD','Invalid monthly payout date.');
      const period=priorBeninMonth(asOf),periodKey=new Date(new Date(period.start).getTime()+3600000).toISOString().slice(0,10);
      const schedules=await db.transaction(async tx=>(await tx.query(`SELECT s.*,o.name AS operator_name,o.owner_user_id,o.verification_status
        FROM operator_payout_schedules s JOIN operators o ON o.id=s.operator_id
        WHERE s.enabled=true AND s.consent_version='monthly-v1' AND o.active=true AND o.verification_status='verified' ORDER BY s.operator_id`,[])).rows);
      const result={processed:0,skipped:0,failed:0,manual:0,period:periodKey,reason:support.canRequest?null:'provider_payouts_unavailable'};
      for(const schedule of schedules){
        const prepared=await db.transaction(async tx=>{
          const lockKey='operator-balance:'+schedule.operator_id;
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[lockKey]);
          const currentSchedule=await one(tx,`SELECT s.*,o.name AS operator_name FROM operator_payout_schedules s
            JOIN operators o ON o.id=s.operator_id WHERE s.operator_id=$1 AND s.enabled=true AND s.consent_version='monthly-v1' AND o.active=true
            AND o.verification_status='verified' FOR UPDATE OF s,o`,[schedule.operator_id]);
          if(!currentSchedule)return {skip:true};
          const prior=await one(tx,"SELECT id,status FROM operator_payout_requests WHERE operator_id=$1 AND payout_kind='monthly' AND payout_period=$2",[schedule.operator_id,periodKey]);
          if(prior)return {skip:true};
          const entries=(await tx.query(`SELECT id,net_minor FROM operator_settlements
            WHERE operator_id=$1 AND source IN ('ticket_online','parcel_online') AND payout_state='available' AND available_at<=now() AND earned_at>=$2 AND earned_at<$3
            AND NOT EXISTS(SELECT 1 FROM payments p WHERE operator_settlements.reference='payment:'||p.id::text AND p.reconciliation='review')
            ORDER BY earned_at,id FOR UPDATE`,[schedule.operator_id,period.start,period.end])).rows;
          const gross=entries.reduce((sum,e)=>sum+e.net_minor,0);
          if(!gross)return {skip:true};
          const debts=await one(tx,"SELECT coalesce(sum(amount_minor-settled_minor),0)::integer AS total FROM operator_settlement_reversals WHERE operator_id=$1 AND state='open'",[schedule.operator_id]);
          const debt=Math.min(gross,debts.total),net=gross-debt;
          if(!net){
            // Even a small month's revenue offsets part of a larger refund debt.
            // This is retained operator fare, not a pretend zero-value transfer.
            let remaining=gross;
            const reversals=(await tx.query("SELECT * FROM operator_settlement_reversals WHERE operator_id=$1 AND state='open' ORDER BY created_at,id FOR UPDATE",[schedule.operator_id])).rows;
            for(const rev of reversals){
              const used=Math.min(remaining,rev.amount_minor-rev.settled_minor);
              if(!used)continue;
              await tx.query("UPDATE operator_settlement_reversals SET settled_minor=settled_minor+$2,state=CASE WHEN settled_minor+$2=amount_minor THEN 'settled' ELSE 'open' END,settled_at=CASE WHEN settled_minor+$2=amount_minor THEN now() ELSE settled_at END WHERE id=$1",[rev.id,used]);
              remaining-=used;
            }
            for(const entry of entries)await tx.query('UPDATE operator_settlements SET deduction_minor=deduction_minor+$2 WHERE id=$1',[entry.id,entry.net_minor]);
            await audit(tx,null,'operator.refund_debt_offset',schedule.operator_id,schedule.operator_id,{period:periodKey,amountMinor:gross});
            return {skip:true};
          }
          const request=await one(tx,`INSERT INTO operator_payout_requests(operator_id,amount_minor,currency,phone_number,country,network,provider,status,
            idempotency_key,request_fingerprint,payout_kind,payout_period,debt_offset_minor,decided_at)
            VALUES($1,$2,'XOF',$3,$4,$5,$6,$11,$7,$8,'monthly',$9,$10,now()) RETURNING *`,
          [schedule.operator_id,net,currentSchedule.phone_number,currentSchedule.country,currentSchedule.network,adapter?.name??'manual',
            `operator-monthly:${schedule.operator_id}:${periodKey}`,digest([schedule.operator_id,periodKey,gross,debt]),periodKey,debt,support.canRequest?'processing':'requested']);
          await tx.query("UPDATE operator_settlements SET payout_state='reserved',payout_request_id=$2 WHERE id=ANY($1)",[entries.map(e=>e.id),request.id]);
          if(debt)await allocateReversals(tx,schedule.operator_id,debt,request.id);
          await audit(tx,null,'operator.monthly_payout_requested',request.id,schedule.operator_id,{period:periodKey,amountMinor:net,debtOffsetMinor:debt});
          await emit(tx,'operator_payout.'+request.status,request.id,{operatorId:schedule.operator_id,amountMinor:net,payoutKind:'monthly',period:periodKey});
          return {request,ownerName:currentSchedule.operator_name};
        });
        if(prepared.skip){result.skipped++;continue;}
        try{
          if(!support.canRequest){result.manual++;continue;}
          const [firstName,...rest]=(prepared.ownerName||'Opérateur').split(/\s+/);
          const transfer=await adapter.createPayout({payoutRequestId:prepared.request.id,firstName,lastName:rest.join(' ')||firstName,
            phoneNumber:prepared.request.phone_number,country:prepared.request.country,amountMinor:prepared.request.amount_minor,
            currency:prepared.request.currency,idempotencyKey:prepared.request.id});
          invariant(transfer&&typeof transfer.reference==='string'&&transfer.reference.length>0&&transfer.reference.length<=150,
            'PAYOUT_UNAVAILABLE','Provider payout initiation was incomplete.');
          await db.transaction(async tx=>{
            await tx.query('UPDATE operator_payout_requests SET provider_reference=$2,provider_metadata=$3,updated_at=now() WHERE id=$1',
              [prepared.request.id,transfer.reference,JSON.stringify(transfer.metadata??{})]);
          });
          result.processed++;
        }catch{
          // An uncertain network response can hide an accepted transfer. Keep the
          // funds reserved and reconcile the persisted request before any retry.
          await db.transaction(tx=>audit(tx,null,'operator.monthly_payout_uncertain',prepared.request.id,schedule.operator_id,{period:periodKey}));
          result.failed++;
        }
      }
      return result;
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
        invariant(!await one(tx,"SELECT id FROM operator_settlements WHERE payout_request_id=$1 AND source IN ('walk_up','parcel_cash') AND payout_state='reserved' LIMIT 1",[r.id]),
          'CASH_RECONCILIATION_REQUIRED','This historical request includes cash already received by the operator. Finance reconciliation is required before any transfer.',409);
        invariant((await capability()).canRequest,'PAYOUT_UNAVAILABLE','Provider payouts are unavailable; manual reconciliation is required.',503);
        if (r.status === 'failed') {
          invariant(!r.provider_reference,'PAYOUT_RECONCILE_REQUIRED','Reconcile the existing provider payout before retrying.',409);
          const period=r.payout_period?priorBeninMonth(new Date(new Date(r.payout_period).getTime()+32*86400000)):null;
          await reserve(tx, r.operator_id, r.amount_minor + (r.debt_offset_minor??0), r.id,period);
          if(r.debt_offset_minor)await allocateReversals(tx,r.operator_id,r.debt_offset_minor,r.id);
        }
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
        await db.transaction(tx=>audit(tx,actor.id,'operator_payout.initiation_uncertain',row.id,row.operator_id,{reconcileRequired:true}));
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
        await tx.query("UPDATE operator_settlement_reversals SET state='open',allocated_minor=0,payout_request_id=NULL WHERE payout_request_id=$1 AND state='allocated'",[r.id]);
        await tx.query("UPDATE operator_reversal_allocations SET state='released' WHERE payout_request_id=$1 AND state='allocated'",[r.id]);
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
