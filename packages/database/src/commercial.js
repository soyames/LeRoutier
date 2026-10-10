// Commercial model, represented as configuration — never as a second billing
// platform. Business rules, enforced and read here:
//
//   companies:        monthly/term subscription, free through 2027-04-30
//   independent:      lower monthly/term subscription, free through 2027-04-30
//
// Renewal is manual. The current payment providers do not provide a confirmed
// recurring mandate for these plans, so this module never schedules charges.

import { invariant, uuid } from '@leroutier/domain';
import { activeIdentity, audit } from './identities.js';
import { requirePlatform } from './platform-access.js';

const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
function addMonthsUtc(date,months){
  const year=date.getUTCFullYear(),month=date.getUTCMonth()+months,day=date.getUTCDate();
  const first=new Date(Date.UTC(year,month,1,date.getUTCHours(),date.getUTCMinutes(),date.getUTCSeconds(),date.getUTCMilliseconds()));
  first.setUTCDate(Math.min(day,new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate()));
  return first;
}

export function commercial(db) {
  return {
    async access(actor) {
      if(!actor?.operator_id || actor.role==='passenger')return {active:true,reason:null};
      return db.transaction(async tx=>{
        const plan=await one(tx,`SELECT trial_ends_at,paid_through FROM operator_plans
          WHERE operator_id=$1 AND effective_to IS NULL`,[actor.operator_id]);
        const trialEnd=plan?.trial_ends_at??'2027-04-30T23:00:00Z';
        const active=Date.now()<new Date(trialEnd).getTime()||!!plan?.paid_through&&Date.now()<new Date(plan.paid_through).getTime();
        return {active,reason:active?null:'subscription_required',trialEndsAt:trialEnd,paidThrough:plan?.paid_through??null};
      });
    },
    async ownPlan(actor) {
      const operatorId=await db.transaction(async tx=>{
        const user=await activeIdentity(tx,actor.id);
        invariant(user.role==='ops'||(user.role==='driver'&&user.operator_type==='independent'),
          'FORBIDDEN','Un compte professionnel est requis.',403);
        invariant(user.operator_id,'NOT_FOUND','Aucun opérateur associé à ce compte.',404);
        const owner=await one(tx,'SELECT owner_user_id,admin_user_id FROM operators WHERE id=$1',[user.operator_id]);
        invariant(owner && (owner.owner_user_id===user.id||owner.admin_user_id===user.id),
          'FORBIDDEN','Seul le titulaire peut gérer l’abonnement.',403);
        return user.operator_id;
      });
      return this.plan({role:'ops',id:actor.id,operator_id:operatorId},operatorId);
    },
    async selectPeriod(actor,input) {
      invariant(input && Object.keys(input).every(k=>k==='billingPeriod') && ['month','six_months','year'].includes(input.billingPeriod),
        'INVALID_SUBSCRIPTION','Choisissez un paiement mensuel, semestriel ou annuel.');
      await db.transaction(async tx=>{
        const user=await activeIdentity(tx,actor.id);
        invariant(user.role==='ops'||(user.role==='driver'&&user.operator_type==='independent'),
          'FORBIDDEN','Un compte professionnel est requis.',403);
        invariant(user.operator_id,'NOT_FOUND','Aucun opérateur associé à ce compte.',404);
        const owner=await one(tx,'SELECT owner_user_id,admin_user_id,type FROM operators WHERE id=$1',[user.operator_id]);
        invariant(owner && (owner.owner_user_id===user.id||owner.admin_user_id===user.id),
          'FORBIDDEN','Seul le titulaire peut choisir la période.',403);
        await tx.query(`INSERT INTO operator_plans(operator_id,plan,monthly_price_minor,billing_status,billing_period,trial_ends_at)
          VALUES($1,'standard',$2,'not_billed',$3,'2027-04-30T23:00:00Z')
          ON CONFLICT (operator_id) WHERE effective_to IS NULL DO UPDATE SET billing_period=EXCLUDED.billing_period,
            monthly_price_minor=EXCLUDED.monthly_price_minor,selected_at=now()`,
        [user.operator_id,owner.type==='company'?30000:10000,input.billingPeriod]);
        await audit(tx,user.id,'operator.subscription_period_selected',user.operator_id,null,{billingPeriod:input.billingPeriod});
      });
      return this.ownPlan(actor);
    },
    async requestPayment(actor,input) {
      invariant(input&&Object.keys(input).every(k=>['provider','reference'].includes(k))&&
        ['fedapay','mtn_momo','moov_momo','bank_transfer','cash'].includes(input.provider)&&
        typeof input.reference==='string'&&input.reference.trim().length>=2&&input.reference.length<=150,
      'INVALID_SUBSCRIPTION_PAYMENT','Fournissez le moyen et la référence du paiement.');
      return db.transaction(async tx=>{
        const user=await activeIdentity(tx,actor.id);
        invariant(user.role==='ops'||(user.role==='driver'&&user.operator_type==='independent'),
          'FORBIDDEN','Un compte professionnel est requis.',403);
        invariant(user.operator_id,'NOT_FOUND','Aucun opérateur associé à ce compte.',404);
        const operator=await one(tx,'SELECT * FROM operators WHERE id=$1',[user.operator_id]);
        invariant(operator&&(operator.owner_user_id===user.id||operator.admin_user_id===user.id),
          'FORBIDDEN','Seul le titulaire peut soumettre un renouvellement.',403);
        const plan=await one(tx,'SELECT billing_period FROM operator_plans WHERE operator_id=$1 AND effective_to IS NULL',[operator.id]);
        const billingPeriod=plan?.billing_period??'month';
        const months={month:1,six_months:6,year:12}[billingPeriod];
        const amountMinor=(operator.type==='company'?30000:10000)*months;
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`subscription-payment:${input.provider}:${input.reference.trim()}`]);
        invariant(!await one(tx,'SELECT id FROM operator_subscription_payments WHERE provider=$1 AND reference=$2',[input.provider,input.reference.trim()]),
          'DUPLICATE_PAYMENT_REFERENCE','Cette référence de paiement a déjà été soumise.',409);
        const request=await one(tx,`INSERT INTO operator_subscription_payments(operator_id,requested_by,billing_period,amount_minor,provider,reference)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING id,operator_id,billing_period,amount_minor,provider,reference,status,created_at`,
        [operator.id,user.id,billingPeriod,amountMinor,input.provider,input.reference.trim()]);
        await audit(tx,user.id,'operator.subscription_payment_submitted',request.id,operator.id,{billingPeriod,amountMinor,provider:input.provider});
        return request;
      });
    },
    async paymentRequests(actor) {
      requirePlatform(actor,'finance');
      return db.transaction(async tx=>(await tx.query(`SELECT p.*,o.name AS operator_name,o.type AS operator_type,u.display_name AS requester_name
        FROM operator_subscription_payments p JOIN operators o ON o.id=p.operator_id JOIN users u ON u.id=p.requested_by
        WHERE p.status='pending' ORDER BY p.created_at`,[])).rows);
    },
    async reviewPayment(actor,id,decision) {
      requirePlatform(actor,'finance');
      invariant(['confirm','reject'].includes(decision),'INVALID_DECISION','Choisissez confirmer ou rejeter.');
      return db.transaction(async tx=>{
        const request=await one(tx,'SELECT * FROM operator_subscription_payments WHERE id=$1 FOR UPDATE',[uuid(id)]);
        invariant(request,'NOT_FOUND','Demande de renouvellement introuvable.',404);
        invariant(request.status==='pending','SUBSCRIPTION_PAYMENT_REVIEWED','Cette demande est déjà traitée.',409);
        let paidThrough=null;
        if(decision==='confirm'){
          const plan=await one(tx,'SELECT trial_ends_at,paid_through FROM operator_plans WHERE operator_id=$1 AND effective_to IS NULL FOR UPDATE',[request.operator_id]);
          invariant(plan,'SUBSCRIPTION_NOT_FOUND','Abonnement introuvable.',404);
          const base=new Date(Math.max(Date.now(),new Date(plan.trial_ends_at).getTime(),plan.paid_through?new Date(plan.paid_through).getTime():0));
          const months={month:1,six_months:6,year:12}[request.billing_period];
          paidThrough=addMonthsUtc(base,months);
          await tx.query(`UPDATE operator_plans SET billing_period=$2,paid_through=$3,last_payment_reference=$4,
            billing_status='billing_pending',selected_at=now() WHERE operator_id=$1 AND effective_to IS NULL`,
          [request.operator_id,request.billing_period,paidThrough,request.reference]);
        }
        const updated=await one(tx,`UPDATE operator_subscription_payments SET status=$2,reviewed_by=$3,reviewed_at=now(),paid_through=$4
          WHERE id=$1 RETURNING *`,[request.id,decision==='confirm'?'confirmed':'rejected',actor.id,paidThrough]);
        await audit(tx,actor.id,'operator.subscription_payment_'+updated.status,request.id,request.operator_id,{amountMinor:request.amount_minor,reference:request.reference,paidThrough});
        return updated;
      });
    },
    async plan(actor, operatorIdParam = null) {
      invariant(actor?.role === 'ops', 'FORBIDDEN', 'Operations access required.', 403);
      const requested = operatorIdParam ? uuid(operatorIdParam) : null;
      // An operator admin may read their own plan only; a platform ops may
      // name any operator explicitly.
      if (actor.operator_id) invariant(!requested || requested === actor.operator_id, 'FORBIDDEN', 'Operation is not permitted.', 403);
      const operatorId = actor.operator_id ?? requested;
      invariant(operatorId, 'INVALID_INPUT', 'Operator is required.', 409);
      return db.transaction(async tx => {
        const operator = await one(tx, 'SELECT id,type,name FROM operators WHERE id=$1 AND active=true', [operatorId]);
        invariant(operator, 'NOT_FOUND', 'Operator not found.', 404);
        const plan = await one(tx, `SELECT plan,monthly_price_minor,billing_status,included_features,effective_from,
            billing_period,trial_ends_at,paid_through,last_payment_reference
          FROM operator_plans WHERE operator_id=$1 AND effective_to IS NULL`, [operatorId]);
        const periodMonths={month:1,six_months:6,year:12};
        const monthlyPriceMinor=operator.type==='company'?30000:10000;
        const billingPeriod=plan?.billing_period ?? 'month';
        const trialEndsAt=plan?.trial_ends_at ?? '2027-05-01T00:00:00.000Z';
        const trialActive=Date.now()<new Date(trialEndsAt).getTime();
        const paidActive=!!plan?.paid_through && Date.now()<new Date(plan.paid_through).getTime();
        return { operatorId, operatorType: operator.type, operatorName:operator.name,
          subscription: { active:trialActive||paidActive, trialActive, trialEndsAt,
            billingPeriod, periodMonths:periodMonths[billingPeriod]??1,
            priceMinor:monthlyPriceMinor*(periodMonths[billingPeriod]??1), monthlyPriceMinor,
            billingStatus:trialActive?'trial':paidActive?'paid':'renewal_required',
            renewalMode:'manual', paidThrough:plan?.paid_through??null,
            lastPaymentReference:plan?.last_payment_reference??null,
            plan:plan?.plan??'standard',includedFeatures:plan?.included_features??[] },
          serviceFeeBp:200 };
      });
    },
  };
}
