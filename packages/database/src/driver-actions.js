import { createHash } from 'node:crypto';
import { invariant, uuid, idempotencyKey } from '@leroutier/domain';
import { transport } from './transport.js';
import { tickets } from './tickets.js';
const nested=tx=>({transaction:fn=>fn(tx)});
export async function recordIncident(db,actor,input){
  invariant(input && Object.keys(input).every(k=>['serviceId','kind','severity','description'].includes(k)),'INVALID_INCIDENT','Unexpected incident fields.');
  uuid(input.serviceId);
  invariant(['breakdown','delay','medical','accident','other'].includes(input.kind) && ['low','medium','high'].includes(input.severity) && typeof input.description==='string' && input.description.trim().length>0 && input.description.length<=2000,'INVALID_INCIDENT','Incident details are invalid.');
  return db.transaction(async tx=>{
    await transport(nested(tx)).authorizeService(tx,actor,input.serviceId);
    const row=(await tx.query('INSERT INTO incidents(service_id,reported_by,kind,severity,description) VALUES($1,$2,$3,$4,$5) RETURNING *',[input.serviceId,actor.id,input.kind,input.severity,input.description.trim()])).rows[0];
    await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',['incident.created',row.id,JSON.stringify({serviceId:input.serviceId,incidentId:row.id})]);return row;
  });
}
export async function driverAction(db,actor,input,key){
  idempotencyKey(key);
  invariant(input && Object.keys(input).every(k=>['type','payload'].includes(k)) && ['board','alight','incident'].includes(input.type),'INVALID_ACTION','Unsupported driver action.');
  const p=input.payload;
  invariant(p && typeof p==='object' && !Array.isArray(p),'INVALID_ACTION','Action payload is required.');
  const fields=input.type==='incident'?['serviceId','kind','severity','description']:['serviceId','bookingId','stopSequence','code'];
  invariant(Object.keys(p).every(k=>fields.includes(k)),'INVALID_ACTION','Unexpected action fields.');uuid(p.serviceId);
  const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['driver-action:'+actor.id+':'+key]);
    const d=transport(nested(tx));await d.authorizeService(tx,actor,p.serviceId);
    const prior=(await tx.query('SELECT * FROM driver_action_receipts WHERE actor_id=$1 AND idempotency_key=$2',[actor.id,key])).rows[0];
    if(prior){invariant(prior.fingerprint===fingerprint,'IDEMPOTENCY_CONFLICT','Action key was reused with different data.',409);return prior.result;}
    let result;
    if(input.type==='incident')result=await recordIncident(nested(tx),actor,p);
    else{
      invariant(Number.isInteger(p.stopSequence),'INVALID_STOP','Stop sequence is required.');
      let bookingId=p.bookingId;
      if(p.code){invariant(input.type==='board' && !p.bookingId,'INVALID_ACTION','Use one ticket identifier.');bookingId=(await tickets(nested(tx)).verify(actor,{code:p.code,serviceId:p.serviceId,stopSequence:p.stopSequence})).bookingId;}
      const b=await d.booking(actor,uuid(bookingId));invariant(b.service_id===p.serviceId,'WRONG_SERVICE','Booking belongs to another service.',409);
      invariant(b.status===(input.type==='board'?'confirmed':'boarded'),'ACTION_CONFLICT','This action has already happened or is no longer valid.',409);
      result=await d.transition(actor,bookingId,input.type,p.stopSequence);
    }
    const response={id:result.id,status:result.status,serviceId:p.serviceId};
    await tx.query('INSERT INTO driver_action_receipts(actor_id,idempotency_key,fingerprint,service_id,result) VALUES($1,$2,$3,$4,$5)',[actor.id,key,fingerprint,p.serviceId,JSON.stringify(response)]);
    return response;
  });
}
