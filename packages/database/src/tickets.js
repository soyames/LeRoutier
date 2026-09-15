import { createHash, randomBytes } from 'node:crypto';
import { invariant, uuid } from '@leroutier/domain';
import { transport } from './transport.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const one=async(tx,sql,args=[]) => (await tx.query(sql,args)).rows[0];
const nested=tx=>({transaction:fn=>fn(tx)});
export function tickets(db){
  async function payable(tx,b){
    const p=await one(tx,"SELECT coalesce(sum(amount_minor),0)::integer AS paid FROM payments WHERE booking_id=$1 AND status='succeeded'",[b.id]);
    invariant(p.paid===b.amount_minor && b.status==='confirmed','TICKET_INVALID','Ticket is not confirmed and paid for boarding.',409);
  }
  return {
    async issue(actor,id){
      invariant(actor.role==='passenger','FORBIDDEN','Passenger access required.',403);
      return db.transaction(async tx=>{
        const b=await transport(nested(tx)).booking(actor,uuid(id));await payable(tx,b);
        const s=await one(tx,'SELECT * FROM services WHERE id=$1',[b.service_id]);
        invariant(['scheduled','active'].includes(s.status) && s.current_sequence<=b.origin_sequence,'TICKET_INVALID','Boarding is no longer available.',409);
        const token='LRT1.'+randomBytes(32).toString('base64url');
        const manualCode='LR-'+randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g).join('-');
        const expires=new Date(Math.min(Date.now()+24*3600_000,new Date(s.departure_at).getTime()+24*3600_000));
        invariant(expires>new Date(),'TICKET_EXPIRED','Ticket validity has ended.',409);
        const ticket=await one(tx,`INSERT INTO ticket_credentials(booking_id,version,token_hash,code_hash,expires_at) VALUES($1,1,$2,$3,$4)
          ON CONFLICT(booking_id) DO UPDATE SET version=ticket_credentials.version+1,token_hash=EXCLUDED.token_hash,code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,issued_at=now()
          RETURNING version,expires_at`,[id,hash(token),hash(manualCode),expires]);
        // Operational precision: the ticket states the exact boarding and
        // arrival locations, not only the cities.
        // The ticket exists: the passenger is told, without the token or code.
        await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',
          ['ticket.ready',b.id,JSON.stringify({bookingId:b.id,serviceId:b.service_id})]);
        const points=await one(tx,`SELECT bdp.name AS departure_name,bdp.description AS departure_landmark,bdp.latitude AS departure_latitude,bdp.longitude AS departure_longitude,op.name AS departure_city,
          bap.name AS arrival_name,bap.description AS arrival_landmark,bap.latitude AS arrival_latitude,bap.longitude AS arrival_longitude,ap.name AS arrival_city
          FROM services s LEFT JOIN boarding_points bdp ON bdp.id=s.departure_point_id LEFT JOIN places op ON op.id=bdp.place_id
          LEFT JOIN boarding_points bap ON bap.id=s.arrival_point_id LEFT JOIN places ap ON ap.id=bap.place_id WHERE s.id=$1`,[s.id]);
        return {bookingId:b.id,serviceId:b.service_id,token,manualCode,version:ticket.version,expiresAt:ticket.expires_at,
          departure:{name:points?.departure_name??null,city:points?.departure_city??null,landmark:points?.departure_landmark??null,
            latitude:points?.departure_latitude??null,longitude:points?.departure_longitude??null},
          arrival:{name:points?.arrival_name??null,city:points?.arrival_city??null,landmark:points?.arrival_landmark??null,
            latitude:points?.arrival_latitude??null,longitude:points?.arrival_longitude??null}};
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
