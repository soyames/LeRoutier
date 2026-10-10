import { createHash } from 'node:crypto';
import { invariant, idempotencyKey, subscriptionFree, subscriptionPrice, subscriptionEnd, OPERATOR_PAID_FROM, SUBSCRIPTION_PRICES } from '@leroutier/domain';
import { activeIdentity, audit } from './identities.js';
const one = async (tx, sql, args = []) => (await tx.query(sql, args)).rows[0];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function commercial(db, adapter = null, clock = () => new Date()) {
  async function scope(tx, actor, requested = null) {
    const user = await activeIdentity(tx, actor.id);
    const id = user.operator_id ?? requested;
    invariant(id, 'FORBIDDEN', 'Compte opérateur requis.', 403);
    const operator = await one(tx, 'SELECT * FROM operators WHERE id=$1 AND active=true', [id]);
    invariant(operator, 'NOT_FOUND', 'Opérateur introuvable.', 404);
    invariant((user.role === 'ops' && (!user.operator_id || user.operator_id === id)) ||
      (operator.type === 'independent' && operator.owner_user_id === user.id), 'FORBIDDEN', 'Accès opérateur requis.', 403);
    invariant(!requested || requested === id, 'FORBIDDEN', 'Accès interdit.', 403);
    return operator;
  }
  async function plan(actor, requested = null) {
    return db.transaction(async tx => {
      const operator = await scope(tx, actor, requested);
      const selected = await one(tx, 'SELECT * FROM operator_subscriptions WHERE operator_id=$1', [operator.id]);
      const free = subscriptionFree(clock());
      const paid = selected?.paid_until && new Date(selected.paid_until) > clock();
      const receipts = (await tx.query('SELECT id,billing_period,amount_minor,provider_fee_minor,billing_contact,currency,status,provider_reference,verified_at,period_start,period_end,checkout_url FROM subscription_payments WHERE operator_id=$1 ORDER BY created_at DESC LIMIT 30', [operator.id])).rows;
      return { operatorId: operator.id, operatorType: operator.type, commissionBp: 200, serviceFeeBp: 200, operatorName: operator.name, prices: SUBSCRIPTION_PRICES[operator.type],
        paymentMethods: adapter ? [{ id: 'hosted', label: 'Paiement sécurisé FedaPay (moyens disponibles chez le prestataire)' }] : [],
        subscription: { active: !!(free || paid), free, renewalMode:'manual', plan: selected ? operator.type : null,
          monthlyPriceMinor: SUBSCRIPTION_PRICES[operator.type].monthly, billingPeriod: selected?.billing_period ?? null,
          billingContact: selected?.billing_contact ?? null, trialActive: free, trialEndsAt: OPERATOR_PAID_FROM, paidThrough: selected?.paid_until ?? null, billingStatus: free ? 'free' : paid ? 'confirmed' : 'payment_due',
          nextDueAt: free ? OPERATOR_PAID_FROM : selected?.paid_until ?? OPERATOR_PAID_FROM }, receipts };
    });
  }
  async function select(actor, input) {
    invariant(input && Object.keys(input).every(k => ['billingPeriod','billingContact','paymentMethod'].includes(k)), 'INVALID_PLAN', 'Champs inattendus.');
    const contact = input.billingContact;
    invariant(contact && Object.keys(contact).every(k => ['name','email','phone','address'].includes(k)) &&
      typeof contact.name === 'string' && contact.name.trim().length >= 2 && contact.name.length <= 160 &&
      typeof contact.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email) && contact.email.length <= 200 &&
      typeof contact.phone === 'string' && /^\+?[0-9 ()-]{8,25}$/.test(contact.phone) &&
      typeof contact.address === 'string' && contact.address.trim().length >= 3 && contact.address.length <= 300,
      'INVALID_CONTACT', 'Confirmez vos coordonnées de facturation.');
    await db.transaction(async tx => {
      const operator = await scope(tx, actor);
      subscriptionPrice(operator.type, input.billingPeriod);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['subscription:' + operator.id]);
      invariant(!await one(tx, "SELECT id FROM subscription_payments WHERE operator_id=$1 AND status='pending'", [operator.id]), 'PAYMENT_PENDING', 'Vérifiez le paiement en attente avant de modifier la formule.', 409);
      await tx.query(`INSERT INTO operator_subscriptions(operator_id,billing_period,billing_contact) VALUES($1,$2,$3)
        ON CONFLICT(operator_id) DO UPDATE SET billing_period=$2,billing_contact=$3,selected_at=now()`, [operator.id, input.billingPeriod, JSON.stringify(contact)]);
      await audit(tx, actor.id, 'subscription.selected', operator.id, operator.id, { billingPeriod: input.billingPeriod, free: subscriptionFree(clock()) });
    });
    return plan(actor);
  }
  async function reconcile(actor, id, trusted = false) {
    const p = await db.transaction(async tx => {
      const payment = await one(tx, 'SELECT * FROM subscription_payments WHERE id=$1', [id]);
      invariant(payment, 'NOT_FOUND', 'Paiement introuvable.', 404);
      if (!trusted) await scope(tx, actor, payment.operator_id);
      return payment;
    });
    invariant(adapter && p.provider === adapter.name, 'PAYMENT_UNAVAILABLE', 'Prestataire indisponible.', 503);
    // Ignore callback/webhook claims. Read the actual transaction with server credentials.
    const event = await adapter.reconcilePayment(p);
    if (!event) return { status: p.status, pending: true };
    invariant(event.paymentId === p.id && event.reference === p.provider_reference && event.amountMinor === p.amount_minor && event.currency === 'XOF', 'PAYMENT_MISMATCH', 'Paiement non conforme.', 409);
    return db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['subscription:' + p.operator_id]);
      const current = await one(tx, 'SELECT * FROM subscription_payments WHERE id=$1 FOR UPDATE', [id]);
      if(event.providerFeeMinor!==undefined){
        invariant(Number.isInteger(event.providerFeeMinor)&&event.providerFeeMinor>=0,'PAYMENT_MISMATCH','Frais du prestataire invalides.',409);
        await tx.query('UPDATE subscription_payments SET provider_fee_minor=$2 WHERE id=$1',[id,event.providerFeeMinor]);
      }
      if(event.refundReview===true)return {status:current.status,pending:true};
      if (current.status === event.status) return { status: current.status };
      invariant(['pending','succeeded'].includes(current.status), 'PAYMENT_TRANSITION', 'État de paiement incompatible.', 409);
      invariant(['pending','succeeded','failed','cancelled','refunded'].includes(event.status), 'PAYMENT_TRANSITION', 'État inconnu.', 409);
      if (event.status === 'succeeded' && current.status === 'pending') {
        invariant(!subscriptionFree(clock()) && new Date(p.created_at) >= new Date(OPERATOR_PAID_FROM), 'FREE_PERIOD', 'Aucun paiement avant le 1er mai 2027.', 409);
        const subscription = await one(tx, 'SELECT * FROM operator_subscriptions WHERE operator_id=$1 FOR UPDATE', [p.operator_id]);
        const start = new Date(Math.max(clock().getTime(), new Date(subscription.paid_until ?? 0).getTime()));
        const end = subscriptionEnd(start, p.billing_period);
        await tx.query('UPDATE operator_subscriptions SET paid_until=$2 WHERE operator_id=$1', [p.operator_id, end]);
        await tx.query('UPDATE subscription_payments SET verified_at=$4,period_start=$2,period_end=$3 WHERE id=$1', [id, start, end, clock()]);
      }
      if (event.status === 'refunded') {
        // A refund revokes this entitlement; other paid receipts remain auditable.
        await tx.query('UPDATE operator_subscriptions SET paid_until=LEAST(paid_until,$2) WHERE operator_id=$1', [p.operator_id, current.period_start ?? clock()]);
      }
      await tx.query('UPDATE subscription_payments SET status=$2 WHERE id=$1', [id, event.status]);
      await audit(tx, null, 'subscription.' + event.status, id, p.operator_id, { providerReference: event.reference });
      return { status: event.status };
    });
  }
  return { plan, ownPlan: plan, selectPeriod: select, select, reconcile,
    async access(actor) {
      if (actor.role === 'passenger' || !actor.operator_id || subscriptionFree(clock())) return { active: true };
      const row = await db.transaction(tx => one(tx, 'SELECT operator_id FROM operator_subscriptions WHERE operator_id=$1 AND paid_until>$2', [actor.operator_id, clock()]));
      return { active: !!row };
    },
    async requestPayment() { invariant(false, 'VERIFIED_CHECKOUT_REQUIRED', 'Use the secure subscription checkout.', 409); },
    async paymentRequests() { return []; },
    async reviewPayment() { invariant(false, 'VERIFIED_PAYMENT_REQUIRED', 'A submitted reference cannot activate a subscription.', 409); },
    async checkout(actor, input, key) {
      idempotencyKey(key);
      invariant(!subscriptionFree(clock()), 'FREE_PERIOD', 'Gratuit jusqu’au 30 avril 2027 inclus. Revenez dès le 1er mai pour payer.', 409);
      invariant(input && Object.keys(input).length === 1 && input.paymentMethod === 'hosted', 'INVALID_METHOD', 'Choisissez le paiement sécurisé.', 400);
      invariant(adapter, 'PAYMENT_UNAVAILABLE', 'Paiement indisponible.', 503);
      const p = await db.transaction(async tx => {
        const operator = await scope(tx, actor);
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['subscription:' + operator.id]);
        const selected = await one(tx, 'SELECT * FROM operator_subscriptions WHERE operator_id=$1', [operator.id]);
        invariant(selected, 'INVALID_PLAN', 'Choisissez une formule et confirmez vos coordonnées.', 409);
        const storedKey = 'subscription:' + operator.id + ':' + key;
        const fingerprint = digest([selected.billing_period, selected.billing_contact]);
        const prior = await one(tx, 'SELECT * FROM subscription_payments WHERE idempotency_key=$1', [storedKey]);
        if (prior) { invariant(prior.request_fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Clé déjà utilisée.', 409); return prior; }
        invariant(!await one(tx, "SELECT id FROM subscription_payments WHERE operator_id=$1 AND status='pending'", [operator.id]), 'PAYMENT_PENDING', 'Vérifiez le paiement existant.', 409);
        return one(tx, `INSERT INTO subscription_payments(operator_id,billing_period,billing_contact,amount_minor,provider,idempotency_key,request_fingerprint,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [operator.id, selected.billing_period, selected.billing_contact, subscriptionPrice(operator.type, selected.billing_period), adapter.name, storedKey, fingerprint, clock()]);
      });
      if (p.provider_reference || p.status !== 'pending') return { id: p.id, status: p.status, checkoutUrl: p.checkout_url };
      // One initiation attempt only. An uncertain result requires reconciliation, never a blind retry.
      const claimed = await db.transaction(tx => one(tx, `UPDATE subscription_payments SET provider_metadata='{"initiating":true}' WHERE id=$1 AND provider_metadata='{}' RETURNING id`, [p.id]));
      invariant(claimed, 'PAYMENT_PENDING', 'Initiation en attente de réconciliation manuelle.', 409);
      const result = await adapter.initiate({ paymentId: p.id, amountMinor: p.amount_minor, currency: 'XOF', idempotencyKey: p.id });
      const url = new URL(result.checkoutUrl);
      invariant(url.protocol === 'https:' && !url.username && !url.password, 'PAYMENT_UNAVAILABLE', 'Lien invalide.', 503);
      await db.transaction(tx => tx.query('UPDATE subscription_payments SET provider_reference=$2,provider_metadata=$3,checkout_url=$4 WHERE id=$1', [p.id, result.reference, JSON.stringify(result.metadata ?? {}), url.href]));
      return { id: p.id, status: 'pending', checkoutUrl: url.href };
    },
    async requireActive(actor) {
      if (actor.role === 'passenger' || !actor.operator_id || subscriptionFree(clock())) return;
      const active = await db.transaction(tx => one(tx, 'SELECT operator_id FROM operator_subscriptions WHERE operator_id=$1 AND paid_until>$2', [actor.operator_id, clock()]));
      invariant(active, 'SUBSCRIPTION_REQUIRED', 'Renouvelez votre abonnement pour utiliser cette fonction professionnelle.', 402);
    },
    async webhook(event) {
      const exists = await db.transaction(tx => one(tx, 'SELECT id FROM subscription_payments WHERE id=$1', [event.paymentId]));
      if (!exists) return null;
      return reconcile(null, exists.id, true);
    },
  };
}
