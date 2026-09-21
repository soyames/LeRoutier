import { createHash, randomBytes } from 'node:crypto';
import { invariant, uuid } from '@leroutier/domain';
import { transport } from './transport.js';
import { bookingDocument } from './booking-document.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const one=async(tx,sql,args=[]) => (await tx.query(sql,args)).rows[0];
const nested=tx=>({transaction:fn=>fn(tx)});
export function tickets(db){
  async function payable(tx,b){
    const p=await one(tx,`SELECT
      coalesce(sum(amount_minor) FILTER (WHERE status='succeeded'),0)::integer AS paid,
      coalesce(sum(amount_minor) FILTER (WHERE status='refunded'),0)::integer AS refunded
      FROM payments WHERE booking_id=$1`,[b.id]);
    invariant(p.paid-p.refunded===b.amount_minor && b.status==='confirmed','TICKET_INVALID','Ticket is not confirmed and paid for boarding.',409);
  }
  return {
    async issue(actor,id){
      invariant(actor.role==='passenger','FORBIDDEN','Passenger access required.',403);
      return db.transaction(async tx=>{
        const b=await transport(nested(tx)).booking(actor,uuid(id));
        invariant(b.status!=='held','TICKET_INVALID','Le paiement doit être confirmé avant l’émission du billet.',409);
        const document=await bookingDocument(tx,id);
        const s=await one(tx,'SELECT * FROM services WHERE id=$1',[b.service_id]);
        const canBoard=b.status==='confirmed' && document.paidMinor-document.refundedMinor===b.amount_minor &&
          ['scheduled','active'].includes(s.status) && s.current_sequence<=b.origin_sequence;
        let ticket=await one(tx,'SELECT * FROM ticket_credentials WHERE booking_id=$1',[id]);
        // Viewing an archive must never depend on eligibility to board again.
        // A previously issued credential remains visible on the passenger's
        // own archived document, while verify() still rejects boarded,
        // completed, cancelled, refunded and expired tickets.
        if(canBoard && (!ticket?.token || new Date(ticket.expires_at)<=new Date())) {
          const expires=new Date(new Date(s.departure_at).getTime()+24*3600_000);
          if(expires>new Date()) {
            const token='LRT1.'+randomBytes(32).toString('base64url');
            const manualCode='LR-'+randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g).join('-');
            ticket=await one(tx,`INSERT INTO ticket_credentials(booking_id,version,token_hash,code_hash,expires_at,token,manual_code)
              VALUES($1,1,$2,$3,$4,$5,$6) ON CONFLICT(booking_id) DO UPDATE SET
              version=ticket_credentials.version+1,token_hash=EXCLUDED.token_hash,code_hash=EXCLUDED.code_hash,
              expires_at=EXCLUDED.expires_at,token=EXCLUDED.token,manual_code=EXCLUDED.manual_code,issued_at=now() RETURNING *`,
            [id,hash(token),hash(manualCode),expires,token,manualCode]);
            await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',
              ['ticket.ready',b.id,JSON.stringify({bookingId:b.id,serviceId:b.service_id})]);
          }
        }
        const validForBoarding=!!(canBoard && ticket?.token && new Date(ticket.expires_at)>new Date());
        return {bookingId:b.id,serviceId:b.service_id,document,validForBoarding,
          token:ticket?.token??null,manualCode:ticket?.manual_code??null,
          version:ticket?.version??null,expiresAt:ticket?.expires_at??null,
          departure:{name:document.departure_point_name,city:document.departure_city,landmark:document.departure_point_landmark,
            latitude:document.departure_point_latitude,longitude:document.departure_point_longitude},
          arrival:{name:document.arrival_point_name,city:document.arrival_city,landmark:document.arrival_point_landmark,
            latitude:document.arrival_point_latitude,longitude:document.arrival_point_longitude}};
      });
    },
    async verify(actor,input){
      invariant(input && Object.keys(input).every(k=>['code','serviceId','stopSequence'].includes(k)),'INVALID_TICKET','Unexpected ticket fields.');
      uuid(input.serviceId);invariant(typeof input.code==='string' && input.code.length<=120 && Number.isInteger(input.stopSequence),'INVALID_TICKET','Ticket code and stop are required.');
      const code=/^lr-/i.test(input.code.trim())?input.code.trim().toUpperCase():input.code.trim();
      return db.transaction(async tx=>{
        const d=transport(nested(tx)),s=await d.authorizeService(tx,actor,input.serviceId);
        const ticket=await one(tx,'SELECT * FROM ticket_credentials WHERE token_hash=$1 OR code_hash=$1',[hash(code)]);
        invariant(ticket && new Date(ticket.expires_at)>new Date(),'TICKET_INVALID','Code is invalid, expired or replaced.',409);
        const b=await one(tx,'SELECT * FROM bookings WHERE id=$1',[ticket.booking_id]);
        invariant(b.service_id===s.id,'WRONG_SERVICE','Ticket belongs to another service.',409);
        invariant(b.status!=='boarded' && b.status!=='completed','ALREADY_BOARDED','Ticket has already been boarded.',409);
        await payable(tx,b);
        invariant(s.status==='active' && s.current_sequence===input.stopSequence && b.origin_sequence===input.stopSequence,'WRONG_STOP','Boarding must happen at the booked stop on an active service.',409);
        return {valid:true,bookingId:b.id,serviceId:s.id,seat:b.seat_number,origin:b.origin_sequence,destination:b.destination_sequence,
          version:ticket.version,expiresAt:ticket.expires_at,verifiedAt:new Date().toISOString()};
      });
    },
  };
}
