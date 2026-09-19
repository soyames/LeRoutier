import { createHash } from 'node:crypto';
import { invariant, uuid, idempotencyKey, splitCommission } from '@leroutier/domain';
import { transport } from './transport.js';
import { operatorSettlements } from './operator-settlements.js';
import { fareIntelligence } from './fare-intelligence.js';
import { audit } from './identities.js';
const one=async(tx,sql,args=[]) => (await tx.query(sql,args)).rows[0];
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const nested=tx=>({transaction:fn=>fn(tx)});
const publicPayment=p=>({id:p.id,bookingId:p.booking_id,provider:p.provider,status:p.status,amountMinor:p.amount_minor,currency:p.currency,checkoutUrl:p.checkout_url,reconciliation:p.reconciliation});

export function payments(db,adapter=null){
  const domain=transport(db);
  const settlements=operatorSettlements(db);
  const fares=fareIntelligence(db);
  async function apply(event){
    invariant(event && Object.keys(event).every(k=>['paymentId','eventId','reference','amountMinor','currency','status'].includes(k)),'INVALID_PAYMENT_EVENT','Invalid payment event.');
    uuid(event.paymentId);
    invariant(typeof event.eventId==='string' && event.eventId.length>0 && event.eventId.length<=150 && typeof event.reference==='string' && event.reference.length>0 && event.reference.length<=150 &&
      Number.isInteger(event.amountMinor) && event.currency==='XOF' && ['pending','succeeded','failed','cancelled','refunded'].includes(event.status),'INVALID_PAYMENT_EVENT','Invalid payment event.');
    return db.transaction(async tx=>{
      const stub=await one(tx,'SELECT booking_id FROM payments WHERE id=$1',[event.paymentId]);
      invariant(stub,'NOT_FOUND','Payment not found.',404);
      const b0=await one(tx,'SELECT * FROM bookings WHERE id=$1',[stub.booking_id]);
      await tx.query('SELECT id FROM services WHERE id=$1 FOR UPDATE',[b0.service_id]);
      const b=await transport(nested(tx)).booking({id:b0.passenger_id,role:'passenger'},b0.id);
      const p=await one(tx,'SELECT * FROM payments WHERE id=$1 FOR UPDATE',[event.paymentId]);
      invariant(p.provider===adapter?.name && p.amount_minor===event.amountMinor && p.currency===event.currency,'PAYMENT_MISMATCH','Provider payment does not match the booking.',409);
      invariant(!p.provider_reference || p.provider_reference===event.reference,'PAYMENT_MISMATCH','Provider reference does not match.',409);
      const hash=digest(event),prior=await one(tx,'SELECT fingerprint FROM payment_events WHERE provider=$1 AND event_id=$2',[p.provider,event.eventId]);
      if(prior){invariant(prior.fingerprint===hash,'EVENT_CONFLICT','Event identifier was reused with different data.',409);return publicPayment(p);}
      invariant(!await one(tx,'SELECT id FROM payments WHERE provider=$1 AND provider_reference=$2 AND id<>$3',[p.provider,event.reference,p.id]),'DUPLICATE_REFERENCE','Provider reference already belongs to another payment.',409);
      const allowed={pending:['pending','succeeded','failed','cancelled'],succeeded:['succeeded','refunded'],failed:['failed'],cancelled:['cancelled'],refunded:['refunded']};
      invariant(allowed[p.status].includes(event.status),'PAYMENT_TRANSITION','Payment event conflicts with its current state.',409);
      await tx.query('UPDATE payments SET provider_reference=$2,status=$3,updated_at=now() WHERE id=$1',[p.id,event.reference,event.status]);
      let reconciliation=event.status==='pending'?'pending':'applied';
      if(event.status==='succeeded' && p.status!=='succeeded'){
        const s=await one(tx,'SELECT * FROM services WHERE id=$1',[b.service_id]);
        const otherPaid=await one(tx,"SELECT id FROM payments WHERE booking_id=$1 AND status='succeeded' AND id<>$2",[b.id,p.id]);
        if(b.status==='held' && !otherPaid && ['scheduled','active'].includes(s.status) && b.origin_sequence>=s.current_sequence && (s.status==='active' || new Date(s.departure_at)>new Date())){
          await transport(nested(tx)).transition({id:b.passenger_id,role:'passenger'},b.id,'confirm');
        }else{reconciliation='review';await audit(tx,null,'payment.refund_review',p.id,s.operator_id,{bookingId:b.id});}
        // The customer paid the final price: the operator settlement credits
        // gross minus commission, and the transaction becomes market evidence.
        // Both are idempotent per payment, so a replayed webhook changes nothing.
        // TEST/demo services never enter real financial settlement or market
        // observations: synthetic money must not move real ledgers.
        if(!s.is_demo) {
          const split=splitCommission(event.amountMinor);
          await settlements.credit(tx,{operatorId:s.operator_id,source:'ticket_online',reference:'payment:'+p.id,
            grossMinor:split.grossMinor,deductionMinor:split.commissionMinor});
          const od=await one(tx,`SELECT o.stop_id AS origin_stop_id,d.stop_id AS destination_stop_id,op.type AS operator_type
            FROM service_stops o JOIN service_stops d ON d.service_id=o.service_id AND d.sequence=$3
            JOIN operators op ON op.id=$2
            WHERE o.service_id=$1 AND o.sequence=$4`, [b.service_id,s.operator_id,b.destination_sequence,b.origin_sequence]);
          if(od) await fares.recordTransaction(tx,{operatorId:s.operator_id,originStopId:od.origin_stop_id,destinationStopId:od.destination_stop_id,
            routeId:s.route_id,fareType:'passenger',priceMinor:event.amountMinor,operatorType:od.operator_type,
            sourceReference:'payment:'+p.id,observedAt:new Date().toISOString()});
        }
      }
      if(event.status==='refunded'){
        if(['held','confirmed'].includes(b.status))await transport(nested(tx)).transition({id:b.passenger_id,role:'passenger'},b.id,'cancel');
        else if(b.status==='boarded')reconciliation='review';
      }
      if(event.status===p.status)reconciliation=p.reconciliation;
      await tx.query('UPDATE payments SET reconciliation=$2 WHERE id=$1',[p.id,reconciliation]);
      await tx.query('INSERT INTO payment_events(provider,event_id,payment_id,fingerprint,status) VALUES($1,$2,$3,$4,$5)',[p.provider,event.eventId,p.id,hash,event.status]);
      await audit(tx,null,'payment.'+event.status,p.id,null,{bookingId:b.id});
      await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',['payment.'+event.status,p.id,JSON.stringify({bookingId:b.id,provider:p.provider,reference:event.reference})]);
      return publicPayment({...p,status:event.status,reconciliation});
    });
  }
  return {
    configured:!!adapter,
    async initiate(actor,id,input,key){
      invariant(adapter,'PAYMENT_UNAVAILABLE','Le paiement en ligne n’est pas encore disponible.',503);
      invariant(input && Object.keys(input).length===0,'INVALID_PAYMENT','Amount and payment state are server controlled.');
      invariant(actor.role==='passenger','FORBIDDEN','Passenger access required.',403);idempotencyKey(key);uuid(id);
      const p=await db.transaction(async tx=>{
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['intent:'+actor.id+key]);
        const b=await transport(nested(tx)).booking(actor,id),s=await one(tx,'SELECT * FROM services WHERE id=$1',[b.service_id]);
        invariant(s.is_demo === false, 'FORBIDDEN', 'Les trajets TEST utilisent uniquement le paiement simulé.', 403);
        const storedKey='intent:'+actor.id+':'+key,prior=await one(tx,'SELECT * FROM payments WHERE idempotency_key=$1',[storedKey]);
        if(prior){invariant(prior.booking_id===id,'IDEMPOTENCY_CONFLICT','Key belongs to another booking.',409);return prior;}
        invariant(b.status==='held' && ['scheduled','active'].includes(s.status) && b.origin_sequence>=s.current_sequence && (s.status==='active' || new Date(s.departure_at)>new Date()),'INVALID_PAYMENT','An active payable hold is required.',409);
        invariant(!await one(tx,"SELECT id FROM payments WHERE booking_id=$1 AND status IN ('pending','succeeded')",[id]),'PAYMENT_EXISTS','Retrieve the existing payment before retrying.',409);
        return one(tx,`INSERT INTO payments(booking_id,provider,amount_minor,status,idempotency_key,request_fingerprint,recorded_by,reconciliation)
          VALUES($1,$2,$3,'pending',$4,$5,$6,'pending') RETURNING *`,[id,adapter.name,b.amount_minor,storedKey,digest([id,adapter.name]),actor.id]);
      });
      if(p.status!=='pending' || p.provider_reference)return publicPayment(p);
      // Provider I/O happens outside DB locks. Provider must honor this persisted key.
      const result=await adapter.initiate({paymentId:p.id,bookingId:p.booking_id,amountMinor:p.amount_minor,currency:p.currency,idempotencyKey:p.id});
      invariant(result && typeof result.reference==='string' && result.reference.length>0 && result.reference.length<=150,'PAYMENT_UNAVAILABLE','Provider initiation was incomplete. Reconcile before retrying.',503);
      let checkout=null;
      if(result.checkoutUrl){try{const u=new URL(result.checkoutUrl);invariant(u.protocol==='https:' && !u.username && !u.password,'PAYMENT_UNAVAILABLE','Invalid payment checkout URL.',503);checkout=u.href;}catch{invariant(false,'PAYMENT_UNAVAILABLE','Invalid payment checkout URL.',503);}}
      const metadata=result.metadata && typeof result.metadata==='object' && !Array.isArray(result.metadata)?result.metadata:{};
      return db.transaction(async tx=>{
        await tx.query('SELECT id FROM services WHERE id=(SELECT service_id FROM bookings WHERE id=$1) FOR UPDATE',[id]);
        const current=await one(tx,'SELECT * FROM payments WHERE id=$1 FOR UPDATE',[p.id]);
        invariant(!current.provider_reference || current.provider_reference===result.reference,'PAYMENT_MISMATCH','Provider returned another reference.',409);
        return publicPayment(await one(tx,'UPDATE payments SET provider_reference=$2,checkout_url=$3,provider_metadata=$4,updated_at=now() WHERE id=$1 RETURNING *',[p.id,result.reference,checkout,JSON.stringify(metadata)]));
      });
    },
    // Read-only status polling: no row locks — the passenger UI polls this
    // every few seconds and must never contend with service operations.
    async status(actor,id){
      invariant(actor?.role==='passenger','FORBIDDEN','Passenger access required.',403);
      return db.transaction(async tx=>{
        const b=await one(tx,'SELECT * FROM bookings WHERE id=$1',[uuid(id)]);
        invariant(b,'NOT_FOUND','Booking not found.',404);
        invariant(b.passenger_id===actor.id,'FORBIDDEN','Booking is not yours.',403);
        return (await tx.query('SELECT * FROM payments WHERE booking_id=$1 ORDER BY created_at DESC',[id])).rows.map(publicPayment);
      });
    },
    async listOps(actor,filter={}){
      invariant(actor?.role==='ops','FORBIDDEN','Operations access required.',403);
      const status=filter.status;
      invariant(status===undefined || ['pending','succeeded','failed','cancelled','refunded'].includes(status),'INVALID_STATUS','Invalid payment status.');
      return db.transaction(async tx=>(await tx.query(`SELECT p.*,b.passenger_id,s.operator_id,u.display_name AS passenger_name FROM payments p
        JOIN bookings b ON b.id=p.booking_id JOIN services s ON s.id=b.service_id JOIN users u ON u.id=b.passenger_id
        WHERE ($1::text IS NULL OR p.status=$1) AND ($2::uuid IS NULL OR s.operator_id=$2) AND p.provider='fedapay'
        ORDER BY p.created_at DESC LIMIT 100`,[status??null,actor.operator_id])).rows
        .map(r=>({...publicPayment(r),passengerName:r.passenger_name,operatorId:r.operator_id})));
    },
    async getById(id){
      const p=await db.transaction(tx=>one(tx,'SELECT * FROM payments WHERE id=$1',[uuid(id)]));
      invariant(p,'NOT_FOUND','Payment not found.',404);
      return p;
    },
    // verifyEvent returns null for events that do not correlate to a LeRoutier
    // payment (another product on the same FedaPay account, unknown event names…).
    // Those are safely ignored: no mutation, and the caller answers 200.
    async webhook(name,raw,headers){
      invariant(adapter && name===adapter.name,'PAYMENT_UNAVAILABLE','Payment integration is unavailable.',503);
      const event=await adapter.verifyEvent(raw,headers);
      if(!event || event.kind!=='payment')return {ignored:true};
      const {paymentId,eventId,reference,amountMinor,currency,status}=event;
      return apply({paymentId,eventId,reference,amountMinor,currency,status});
    },
    // Apply an already-verified collection event (shared webhook route).
    applyEvent(event){
      invariant(event?.kind==='payment','INVALID_PAYMENT_EVENT','Not a payment event.');
      const {paymentId,eventId,reference,amountMinor,currency,status}=event;
      return apply({paymentId,eventId,reference,amountMinor,currency,status});
    },
    async reconcile(actor,id){
      uuid(id);const p=await db.transaction(tx=>one(tx,'SELECT * FROM payments WHERE id=$1',[id]));invariant(p,'NOT_FOUND','Payment not found.',404);
      await domain.booking(actor,p.booking_id);
      invariant(adapter && p.provider===adapter.name,'PAYMENT_UNAVAILABLE','Payment integration is unavailable.',503);
      const event=await adapter.reconcilePayment(p);
      if(!event)return {ignored:true};
      const {paymentId,eventId,reference,amountMinor,currency,status}=event;
      return apply({paymentId,eventId,reference,amountMinor,currency,status});
    },
    async manual(actor,id,input,key){return db.transaction(async tx=>{
      const d=transport(nested(tx)),p=await d.recordPayment(actor,id,input,key);
      await d.transition(actor,id,'confirm');await audit(tx,actor.id,'payment.manual_reconciliation',p.id,actor.operator_id,{bookingId:id});
      return publicPayment(p);
    });},
  };
}
