// Commercial model, represented as configuration — never as a second billing
// platform. Business rules, enforced and read here:
//
//   companies:        fixed monthly SaaS subscription + 5% transaction commission
//   independent:      no subscription (0) + 5% transaction commission
//
// The plan's monthly amount stays administrative (NULL) until the owner
// decides business pricing; billing is never activated by this code.

import { invariant, uuid, LEROUTIER_COMMISSION_BP } from '@leroutier/domain';

const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];

export function commercial(db) {
  return {
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
        if (operator.type === 'independent') {
          // Policy: independent owner-drivers currently pay no subscription.
          return { operatorId, operatorType: 'independent',
            subscription: { active: false, monthlyPriceMinor: 0, billingStatus: 'none', plan: null },
            commissionBp: LEROUTIER_COMMISSION_BP };
        }
        const plan = await one(tx, `SELECT plan,monthly_price_minor,billing_status,included_features,effective_from
          FROM operator_plans WHERE operator_id=$1 AND effective_to IS NULL`, [operatorId]);
        return { operatorId, operatorType: 'company',
          subscription: plan ? { active: true, plan: plan.plan, monthlyPriceMinor: plan.monthly_price_minor,
            billingStatus: plan.billing_status, includedFeatures: plan.included_features } :
            { active: false, plan: null, monthlyPriceMinor: null, billingStatus: 'none', includedFeatures: [] },
          commissionBp: LEROUTIER_COMMISSION_BP };
      });
    },
  };
}
