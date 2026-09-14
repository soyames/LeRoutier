import { randomUUID } from 'node:crypto';
import { DomainError, invariant, uuid } from '@leroutier/domain';
import { transport } from '@leroutier/database/transport';
import { validatePosition } from '@leroutier/geo';
import { enqueue } from '@leroutier/notifications';
import { authentication } from './auth.js';

export function createApi(db, config) {
  const domain=transport(db), auth=authentication(db,config);
  const list=(query,params=[])=>db.transaction(async tx=>(await tx.query(query,params)).rows);
  async function limited(subject) {
    await db.transaction(async tx=>{
      const {rows}=await tx.query(`INSERT INTO request_limits(subject,window_at,requests) VALUES($1,date_trunc('minute',now()),1)
        ON CONFLICT(subject,window_at) DO UPDATE SET requests=request_limits.requests+1 RETURNING requests`,[subject]);
      invariant(rows[0].requests<=120,'RATE_LIMITED','Too many requests. Try again shortly.',429);
    });
  }
  async function route(request) {
    const url=new URL(request.url), path=url.pathname.replace(/\/$/,'') || '/';
    const method=request.method;
    const body=async()=>{
      invariant((request.headers.get('content-type') || '').includes('application/json'),'INVALID_BODY','JSON is required.');
      const text=await request.text();
      invariant(text.length<=16_384,'INVALID_BODY','Request is too large.',413);
      try { const b=JSON.parse(text);invariant(b && typeof b==='object' && !Array.isArray(b),'INVALID_BODY','An object is required.');return b; }
      catch { throw new DomainError('INVALID_BODY','Invalid JSON.'); }
    };
    if(method==='GET' && path==='/health') {await list('SELECT 1');return {status:'ok'};}
    if(method==='GET' && path==='/auth/config') return {demoLogin:config.demoLogin};
    if(method==='POST' && path==='/auth/demo') {invariant(config.demoLogin,'NOT_FOUND','Endpoint not found.',404);await limited('demo-login');return auth.demoSession((await body()).role);}
    if(method==='GET' && path==='/stops') {
      const search=(url.searchParams.get('q') || '').slice(0,100);
      return list(`SELECT s.*,p.name AS city FROM stops s JOIN places p ON p.id=s.place_id
        WHERE s.name ILIKE $1 OR p.name ILIKE $1 ORDER BY p.name,s.name LIMIT 100`,['%'+search+'%']);
    }
    if(method==='GET' && path==='/places') return list('SELECT * FROM places WHERE name ILIKE $1 ORDER BY name LIMIT 100',['%'+(url.searchParams.get('q')||'').slice(0,100)+'%']);
    if(method==='GET' && path==='/routes') return list(`SELECT r.*,coalesce((SELECT json_agg(json_build_object('sequence',rs.sequence,'stopId',s.id,'name',s.name,'city',p.name) ORDER BY rs.sequence)
      FROM route_stops rs JOIN stops s ON s.id=rs.stop_id JOIN places p ON p.id=s.place_id WHERE rs.route_id=r.id),'[]') AS stops FROM routes r WHERE active=true ORDER BY name`);
    if(method==='GET' && path==='/services') {
      const origin=url.searchParams.get('originStopId'), destination=url.searchParams.get('destinationStopId');
      invariant(!origin===!destination,'INVALID_JOURNEY','Both origin and destination are required.');
      if(origin) {uuid(origin);uuid(destination);}
      const services=await list(`SELECT s.*,r.name AS route_name,o.name AS operator_name,v.registration,
        (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$1) AS origin,
        (SELECT sequence FROM service_stops WHERE service_id=s.id AND stop_id=$2) AS destination
        FROM services s JOIN routes r ON r.id=s.route_id JOIN operators o ON o.id=s.operator_id
        JOIN service_assignments a ON a.service_id=s.id AND a.ended_at IS NULL JOIN vehicles v ON v.id=a.vehicle_id
        WHERE s.status IN ('scheduled','active') AND (s.departure_at>now() OR s.status='active')
        ORDER BY s.departure_at LIMIT 50`,[origin,destination]);
      const result=[];
      for(const service of services) {
        const from=origin?service.origin:service.current_sequence;
        const to=destination?service.destination:(await list('SELECT max(sequence)::integer AS sequence FROM service_stops WHERE service_id=$1',[service.id]))[0].sequence;
        if(from===null || to===null || from>=to || from<service.current_sequence) continue;
        result.push({...service,availability:await domain.availability(service.id,from,to)});
      }
      return result;
    }
    const available=path.match(/^\/services\/([^/]+)\/availability$/);
    if(method==='GET' && available) return domain.availability(uuid(available[1]),Number(url.searchParams.get('origin')),Number(url.searchParams.get('destination')));
    const actor=await auth.authenticate(request);
    if(method!=='GET') await limited(actor.id);
    if(method==='GET' && path==='/me') return actor;
    if(method==='POST' && path==='/bookings') return domain.hold(actor,await body(),request.headers.get('idempotency-key'));
    if(method==='GET' && path==='/me/bookings') return domain.passengerBookings(actor);
    const booking=path.match(/^\/bookings\/([^/]+)(?:\/(confirm|cancel|board|alight|payments))?$/);
    if(booking) {
      const id=uuid(booking[1]),action=booking[2];
      if(method==='GET' && !action) return domain.booking(actor,id);
      if(method==='POST' && action==='payments') return domain.recordPayment(actor,id,await body(),request.headers.get('idempotency-key'));
      if(method==='POST' && action) return domain.transition(actor,id,action,['board','alight'].includes(action)?(await body()).stopSequence:undefined);
    }
    if(method==='GET' && path==='/driver/service') {
      invariant(actor.role==='driver','FORBIDDEN','Driver access required.',403);
      const rows=await list(`SELECT s.*,r.name AS route_name,v.registration FROM service_assignments a JOIN services s ON s.id=a.service_id
        JOIN routes r ON r.id=s.route_id JOIN vehicles v ON v.id=a.vehicle_id WHERE a.driver_id=$1 AND a.ended_at IS NULL
        AND s.status IN ('scheduled','active','disrupted') ORDER BY departure_at LIMIT 1`,[actor.id]);
      if(!rows[0]) return null;
      const stops=await list(`SELECT ss.sequence,ss.stop_id,s.name,p.name AS city FROM service_stops ss JOIN stops s ON s.id=ss.stop_id
        JOIN places p ON p.id=s.place_id WHERE ss.service_id=$1 ORDER BY sequence`,[rows[0].id]);
      return {...rows[0],stops};
    }
    const service=path.match(/^\/services\/([^/]+)\/(manifest|advance|positions|status|recovery)$/);
    if(service) {
      const id=uuid(service[1]),action=service[2];
      if(method==='GET' && action==='manifest') return domain.manifest(actor,id);
      if(method==='POST' && action==='advance') return domain.advance(actor,id,(await body()).sequence);
      if(method==='GET' && action==='positions') return db.transaction(async tx=>{
        if(actor.role==='passenger') invariant((await tx.query("SELECT id FROM bookings WHERE service_id=$1 AND passenger_id=$2 AND status IN ('confirmed','boarded')",[id,actor.id])).rowCount,'FORBIDDEN','An active ticket is required.',403);
        else await domain.authorizeService(tx,actor,id);
        return (await tx.query('SELECT latitude,longitude,observed_at FROM vehicle_positions WHERE service_id=$1 ORDER BY observed_at DESC LIMIT 1',[id])).rows[0] || null;
      });
      if(method==='POST' && action==='positions') {
        const input=validatePosition(await body());
        return db.transaction(async tx=>{
          await domain.authorizeService(tx,actor,id);
          const previous=(await tx.query('SELECT observed_at FROM vehicle_positions WHERE service_id=$1 ORDER BY observed_at DESC LIMIT 1',[id])).rows[0];
          invariant(!previous || new Date(input.observedAt)>new Date(previous.observed_at),'STALE_POSITION','A newer position is already stored.',409);
          const assignment=(await tx.query('SELECT vehicle_id FROM service_assignments WHERE service_id=$1 AND ended_at IS NULL',[id])).rows[0];
          const result=await tx.query(`INSERT INTO vehicle_positions(service_id,vehicle_id,actor_id,latitude,longitude,observed_at)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING latitude,longitude,observed_at`,[id,assignment.vehicle_id,actor.id,input.latitude,input.longitude,input.observedAt]);
          return result.rows[0];
        });
      }
      if(method==='POST' && action==='status') {
        const input=await body();
        return db.transaction(async tx=>{
          const s=await domain.authorizeService(tx,actor,id,true);
          invariant(['active','disrupted','completed','cancelled'].includes(input.status),'INVALID_STATUS','Invalid service status.');
          const allowed={scheduled:['active','cancelled'],active:['disrupted','completed'],disrupted:['active','cancelled'],completed:[],cancelled:[]};
          invariant(allowed[s.status].includes(input.status),'INVALID_TRANSITION','Service transition is invalid.',409);
          if(['completed','cancelled'].includes(input.status)) {
            invariant(!(await tx.query("SELECT id FROM bookings WHERE service_id=$1 AND status IN ('held','confirmed','boarded')",[id])).rowCount,'ACTIVE_BOOKINGS','Resolve active bookings before closing this service.',409);
            await tx.query('UPDATE service_assignments SET ended_at=now() WHERE service_id=$1 AND ended_at IS NULL',[id]);
          }
          const result=(await tx.query('UPDATE services SET status=$2,updated_at=now() WHERE id=$1 RETURNING *',[id,input.status])).rows[0];
          await enqueue(tx,'service.status',id,{status:input.status});return result;
        });
      }
      if(method==='POST' && action==='recovery') {
        const input=await body();uuid(input.vehicleId);uuid(input.driverId);uuid(input.incidentId);
        return db.transaction(async tx=>{
          const s=await domain.authorizeService(tx,actor,id,true);
          invariant(['active','disrupted'].includes(s.status),'INVALID_TRANSITION','Service is not recoverable.',409);
          invariant((await tx.query("SELECT id FROM incidents WHERE id=$1 AND service_id=$2 AND status<>'resolved'",[input.incidentId,id])).rowCount,'INVALID_INCIDENT','An open incident on this service is required.');
          const v=(await tx.query("SELECT * FROM vehicles WHERE id=$1 AND operator_id=$2 AND status='active' FOR UPDATE",[input.vehicleId,s.operator_id])).rows[0];
          invariant(v && v.capacity>=s.capacity,'INSUFFICIENT_REPLACEMENT','Replacement must support every existing seat.',409);
          invariant((await tx.query('SELECT user_id FROM driver_profiles WHERE user_id=$1 AND operator_id=$2 AND active=true',[input.driverId,s.operator_id])).rowCount,'INVALID_DRIVER','Driver is not available for this operator.');
          const prior=(await tx.query('SELECT id FROM service_assignments WHERE service_id=$1 AND ended_at IS NULL',[id])).rows[0];
          invariant(prior,'INVALID_ASSIGNMENT','Current assignment is missing.',409);
          await tx.query('UPDATE service_assignments SET ended_at=now() WHERE id=$1',[prior.id]);
          const replacement=(await tx.query('INSERT INTO service_assignments(service_id,vehicle_id,driver_id) VALUES($1,$2,$3) RETURNING id',[id,input.vehicleId,input.driverId])).rows[0];
          const result=(await tx.query(`INSERT INTO recovery_assignments(service_id,incident_id,previous_assignment_id,replacement_assignment_id,from_sequence,actor_id)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[id,input.incidentId,prior.id,replacement.id,s.current_sequence,actor.id])).rows[0];
          await enqueue(tx,'service.recovery',id,{recoveryId:result.id});return result;
        });
      }
    }
    if(method==='GET' && path==='/ops/bookings') {
      invariant(actor.role==='ops','FORBIDDEN','Operations access required.',403);
      await domain.expireHolds();
      return list(`SELECT b.*,u.display_name AS passenger_name FROM bookings b JOIN users u ON u.id=b.passenger_id
        JOIN services s ON s.id=b.service_id WHERE b.status='held' AND ($1::uuid IS NULL OR s.operator_id=$1)
        ORDER BY b.created_at DESC LIMIT 100`,[actor.operator_id]);
    }
    if(method==='GET' && path==='/ops/fleet') {
      invariant(actor.role==='ops','FORBIDDEN','Operations access required.',403);
      const services=await list(`SELECT s.*,r.name AS route_name,v.registration,u.display_name AS driver_name FROM services s JOIN routes r ON r.id=s.route_id
        LEFT JOIN service_assignments a ON a.service_id=s.id AND a.ended_at IS NULL LEFT JOIN vehicles v ON v.id=a.vehicle_id LEFT JOIN users u ON u.id=a.driver_id
        WHERE ($1::uuid IS NULL OR s.operator_id=$1) ORDER BY departure_at DESC LIMIT 100`,[actor.operator_id]);
      for(const s of services) { const stops=await list('SELECT max(sequence)::integer AS last FROM service_stops WHERE service_id=$1',[s.id]);
        s.availability=s.current_sequence<stops[0].last?await domain.availability(s.id,s.current_sequence,stops[0].last):null; }
      return {services,vehicles:await list('SELECT * FROM vehicles WHERE ($1::uuid IS NULL OR operator_id=$1)',[actor.operator_id])};
    }
    if(method==='GET' && path==='/incidents') {
      invariant(actor.role!=='passenger','FORBIDDEN','Crew access required.',403);
      return list(`SELECT i.* FROM incidents i JOIN services s ON s.id=i.service_id WHERE
        ($1='ops' AND ($2::uuid IS NULL OR s.operator_id=$2)) OR ($1='driver' AND EXISTS(SELECT 1 FROM service_assignments a WHERE a.service_id=s.id AND a.driver_id=$3 AND a.ended_at IS NULL)) ORDER BY created_at DESC LIMIT 100`,[actor.role,actor.operator_id,actor.id]);
    }
    if(method==='POST' && path==='/incidents') {
      const input=await body();uuid(input.serviceId);
      invariant(['breakdown','delay','medical','accident','other'].includes(input.kind) && ['low','medium','high'].includes(input.severity) && typeof input.description==='string' && input.description.trim().length>0 && input.description.length<=2000,'INVALID_INCIDENT','Incident details are invalid.');
      return db.transaction(async tx=>{
        await domain.authorizeService(tx,actor,input.serviceId);
        const row=(await tx.query('INSERT INTO incidents(service_id,reported_by,kind,severity,description) VALUES($1,$2,$3,$4,$5) RETURNING *',[input.serviceId,actor.id,input.kind,input.severity,input.description.trim()])).rows[0];
        await enqueue(tx,'incident.created',row.id,{serviceId:input.serviceId});return row;
      });
    }
    const incident=path.match(/^\/incidents\/([^/]+)$/);
    if(method==='PATCH' && incident) {
      const input=await body();uuid(incident[1]);invariant(['open','investigating','resolved'].includes(input.status),'INVALID_STATUS','Invalid incident status.');
      return db.transaction(async tx=>{
        const row=(await tx.query('SELECT * FROM incidents WHERE id=$1',[incident[1]])).rows[0];
        invariant(row,'NOT_FOUND','Incident not found.',404);await domain.authorizeService(tx,actor,row.service_id,true);
        const result=(await tx.query('UPDATE incidents SET status=$2,updated_at=now() WHERE id=$1 RETURNING *',[row.id,input.status])).rows[0];
        await enqueue(tx,'incident.updated',row.id,{status:input.status});return result;
      });
    }
    throw new DomainError('NOT_FOUND','Endpoint not found.',404);
  }
  return async request=>{
    const origin=request.headers.get('origin');
    const allowed=!origin || config.corsOrigins.includes(origin);
    const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','vary':'Origin'};
    if(origin && allowed) headers['access-control-allow-origin']=origin;
    try {
      invariant(allowed,'FORBIDDEN','Origin is not allowed.',403);
      if(request.method==='OPTIONS') return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':'GET,POST,PATCH,OPTIONS','access-control-allow-headers':'Authorization,Content-Type,Idempotency-Key'}});
      return new Response(JSON.stringify({data:await route(request)}),{headers});
    } catch(error) {
      const known=error instanceof DomainError;
      const conflict=['23505','23514','23503'].includes(error.code);
      return new Response(JSON.stringify({error:{code:known?error.code:conflict?'CONFLICT':'INTERNAL_ERROR',message:known?error.message:conflict?'The operation conflicts with current data.':'The service is temporarily unavailable.',requestId:randomUUID()}}),{status:known?error.status:conflict?409:503,headers});
    }
  };
}
