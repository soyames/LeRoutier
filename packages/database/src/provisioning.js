import { createHash } from 'node:crypto';
import { invariant, uuid, idempotencyKey, journeySegments } from '@leroutier/domain';
import { activeIdentity, audit, managesOperator } from './identities.js';
import { fareIntelligence } from './fare-intelligence.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function text(value,label,max=100){invariant(typeof value==='string' && value.trim().length>0 && value.length<=max,'INVALID_INPUT',`${label} is required.`);return value.trim();}
function only(input,keys){invariant(input && Object.keys(input).every(k=>keys.includes(k)),'INVALID_INPUT','Unexpected fields are not allowed.');}
const row=async(tx,sql,args=[]) => (await tx.query(sql,args)).rows[0];

/**
 * Who may provision inventory for an operator.
 *
 * Not simply role='ops'. An independent owner-driver is registered with
 * role='driver' — they have to be, because a service assignment names a driver
 * — and every provisioning mutation went through a role check they could never
 * satisfy. The effect was a dead end at the end of the onboarding funnel: an
 * independent operator passed KYC, was verified by a human, and then could not
 * create a route or publish a single departure. Ever.
 *
 * The authority comes from OWNING the operator, not from the name of the role.
 * For a one-person independent operator, the owner IS the operations function;
 * for a company, operations is a separate job held by role='ops'. Both end up
 * scoped identically, because every mutation below resolves its operator
 * through operatorScope().
 */
async function opsActor(tx,actor){
  invariant(actor?.id,'FORBIDDEN','Operations access required.',403);
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor.id]);
  const current=await activeIdentity(tx,actor.id);
  invariant(managesOperator(current),'FORBIDDEN','Operations access required.',403);
  return current;
}
async function operatorScope(tx,actor,id){
  uuid(id);invariant(!actor.operator_id || actor.operator_id===id,'FORBIDDEN','Operator access denied.',403);
  invariant(await row(tx,'SELECT id FROM operators WHERE id=$1 AND active=true',[id]),'NOT_FOUND','Operator not found.',404);
  return id;
}
/**
 * Creating accounts is not part of owning a one-person operator.
 *
 * An independent owner-driver may provision their own inventory — vehicles,
 * routes, departures — but never people. Letting them would let them mint an
 * ops account inside their own operator, and that account could approve their
 * withdrawals: requesting money and releasing it would collapse into one
 * person, which is the separation operator-settlements exists to keep. An
 * independent operator that genuinely needs staff is becoming a company, and
 * that is a reviewed decision rather than a form.
 */
function staffingActor(current){
  invariant(current.role==='ops','FORBIDDEN',
    'La création de comptes est réservée à l’exploitation. Contactez LeRoutier pour ajouter du personnel.',403);
  return current;
}

async function provisionUser(tx,actor,input,role,issuer){
  staffingActor(actor);
  const fields=role==='driver'?['subject','displayName','operatorId','licenseReference']:['subject','displayName','operatorId'];
  only(input,fields);
  invariant(issuer,'AUTH_UNAVAILABLE','Configure the identity issuer before provisioning.',503);
  const subject=text(input.subject,'Identity subject',255),name=text(input.displayName,'Name');
  const operatorId=await operatorScope(tx,actor,input.operatorId);
  if(role==='driver')text(input.licenseReference,'License reference');
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['identity:'+subject]);
  let user=await row(tx,'SELECT * FROM users WHERE auth_subject=$1 FOR UPDATE',[subject]);
  if(user){
    invariant(user.auth_issuer===issuer,'IDENTITY_CONFLICT','Identity is associated with another issuer.',409);
    invariant(user.id!==actor.id,'FORBIDDEN','You cannot change your own privileged account.',403);
    invariant(!user.operator_id || user.operator_id===operatorId,'FORBIDDEN','Identity belongs to another operator.',403);
    invariant(user.role==='passenger' || (user.role===role && user.operator_id===operatorId),'ROLE_CONFLICT','Use an explicit reviewed role change for this account.',409);
    invariant(user.active,'ACCOUNT_DISABLED','Reactivate an existing account explicitly.',409);
    user=await row(tx,'UPDATE users SET role=$2,operator_id=$3,display_name=$4,profile_completed_at=now(),updated_at=now() WHERE id=$1 RETURNING id,role,operator_id,display_name',[user.id,role,operatorId,name]);
  }else{
    user=await row(tx,`INSERT INTO users(auth_subject,auth_issuer,display_name,role,operator_id,profile_completed_at)
      VALUES($1,$2,$3,$4,$5,now()) RETURNING id,role,operator_id,display_name`,[subject,issuer,name,role,operatorId]);
  }
  if(role==='driver')await tx.query(`INSERT INTO driver_profiles(user_id,operator_id,license_reference,active) VALUES($1,$2,$3,true)
    ON CONFLICT(user_id) DO UPDATE SET license_reference=EXCLUDED.license_reference`,[user.id,operatorId,input.licenseReference.trim()]);
  if(role==='convoyeur')await tx.query(`INSERT INTO convoyeur_profiles(user_id,operator_id,active) VALUES($1,$2,true)
    ON CONFLICT(user_id) DO UPDATE SET active=true`,[user.id,operatorId]);
  await audit(tx,actor.id,'identity.role_assigned',user.id,operatorId,{role});
  return user;
}

export function provisioning(db,{issuer}={issuer:undefined}) {
  const fares = fareIntelligence(db);
  async function mutate(actor,kind,input,key,fn){
    idempotencyKey(key);const fingerprint=hash([kind,input]);
    return db.transaction(async tx=>{
      const current=await opsActor(tx,actor);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['provision:'+current.id+key]);
      const prior=await row(tx,'SELECT * FROM provisioning_requests WHERE actor_id=$1 AND idempotency_key=$2',[current.id,key]);
      if(prior){invariant(prior.fingerprint===fingerprint,'IDEMPOTENCY_CONFLICT','The key was used for another operation.',409);return prior.response;}
      const response=await fn(tx,current);
      await tx.query('INSERT INTO provisioning_requests(actor_id,idempotency_key,fingerprint,response) VALUES($1,$2,$3,$4)',[current.id,key,fingerprint,JSON.stringify(response)]);
      return response;
    });
  }
  return {
    /**
     * Known corridors, as a starting point for a route.
     *
     * A corridor is a road people travel. It says nothing about whether
     * anybody is driving it today, it belongs to no operator, and it carries
     * no fares — adopting one pre-fills the stop sequence of a NEW route that
     * is then entirely the operator's, fares included. A passenger never sees
     * a corridor; only published services reach search.
     *
     * Public to any operator manager, because it is public knowledge: these
     * are the roads, not anybody's commercial plan.
     */
    async corridors(actor){return db.transaction(async tx=>{
      await opsActor(tx,actor);
      return (await tx.query(`SELECT c.id,c.name,c.description,c.country_codes AS "countryCodes",
        coalesce((SELECT json_agg(json_build_object('sequence',cs.sequence-1,'stopId',s.id,'name',s.name,'city',p.name)
          ORDER BY cs.sequence) FROM corridor_stops cs JOIN stops s ON s.id=cs.stop_id JOIN places p ON p.id=s.place_id
          WHERE cs.corridor_id=c.id),'[]') AS stops
        FROM corridors c WHERE c.active ORDER BY c.name`)).rows;
    });},

    async catalog(actor){return db.transaction(async tx=>{
      const current=await opsActor(tx,actor),scope=[current.operator_id];
      return {
        operators:(await tx.query('SELECT id,name,active FROM operators WHERE ($1::uuid IS NULL OR id=$1) ORDER BY name',scope)).rows,
        users:(await tx.query(`SELECT u.id,u.display_name,u.role,u.operator_id,u.active,d.license_reference,d.active AS driver_active,c.active AS convoyeur_active FROM users u
          LEFT JOIN driver_profiles d ON d.user_id=u.id LEFT JOIN convoyeur_profiles c ON c.user_id=u.id
          WHERE u.role IN ('ops','driver','convoyeur') AND ($1::uuid IS NULL OR u.operator_id=$1) ORDER BY u.display_name`,scope)).rows,
        routes:(await tx.query('SELECT id,name,operator_id FROM routes WHERE ($1::uuid IS NULL OR operator_id=$1) ORDER BY name',scope)).rows,
        vehicles:(await tx.query('SELECT * FROM vehicles WHERE ($1::uuid IS NULL OR operator_id=$1) ORDER BY registration',scope)).rows,
        places:(await tx.query('SELECT id,name FROM places ORDER BY name LIMIT 500')).rows,
        stops:(await tx.query('SELECT id,name,place_id FROM stops ORDER BY name LIMIT 500')).rows,
      };
    });},
    operator(actor,input,key){return mutate(actor,'operator',input,key,async(tx,current)=>{
      only(input,['name','key']);invariant(!current.operator_id,'FORBIDDEN','Only platform operations can create operators.',403);
      const name=text(input.name,'Operator name'),provisioningKey=text(input.key,'Operator key',60);
      invariant(/^[a-z0-9-]+$/.test(provisioningKey),'INVALID_INPUT','Use a lowercase operator key.');
      // Platform provisioning is a reviewed human action: the operator starts
      // verified. Self-service onboarding starts pending_verification instead.
      const operator=await row(tx,"INSERT INTO operators(name,provisioning_key,verification_status) VALUES($1,$2,'verified') RETURNING id,name,active",[name,provisioningKey]);
      await audit(tx,current.id,'operator.created',operator.id,operator.id);return operator;
    });},
    driver:(actor,input,key)=>mutate(actor,'driver',input,key,(tx,current)=>provisionUser(tx,current,input,'driver',issuer)),
    convoyeur:(actor,input,key)=>mutate(actor,'convoyeur',input,key,(tx,current)=>provisionUser(tx,current,input,'convoyeur',issuer)),
    opsUser:(actor,input,key)=>mutate(actor,'ops-user',input,key,(tx,current)=>provisionUser(tx,current,input,'ops',issuer)),
    userStatus(actor,id,input,key){return mutate(actor,'user-status:'+id,input,key,async(tx,current)=>{
      staffingActor(current);
      only(input,['active']);uuid(id);invariant(typeof input.active==='boolean','INVALID_INPUT','Active must be boolean.');
      const target=await row(tx,'SELECT * FROM users WHERE id=$1 FOR UPDATE',[id]);
      invariant(target,'NOT_FOUND','User not found.',404);invariant(target.id!==current.id,'FORBIDDEN','You cannot disable yourself.',403);
      if(current.operator_id)invariant(target.operator_id===current.operator_id,'FORBIDDEN','Operator access denied.',403);
      invariant(target.role!=='ops' || target.operator_id!==null,'FORBIDDEN','Platform operators require database-administrator review.',403);
      if(!input.active)invariant(!await row(tx,'SELECT id FROM service_assignments WHERE driver_id=$1 AND ended_at IS NULL',[id]),'DRIVER_ASSIGNED','Reassign the active service before disabling this driver.',409);
      await tx.query('UPDATE users SET active=$2,updated_at=now() WHERE id=$1',[id,input.active]);
      if(target.role==='driver')await tx.query('UPDATE driver_profiles SET active=$2 WHERE user_id=$1',[id,input.active]);
      await tx.query('DELETE FROM api_sessions WHERE user_id=$1',[id]);
      await audit(tx,current.id,'identity.activation_changed',id,target.operator_id,{active:input.active});
      return {id,active:input.active};
    });},
    place(actor,input,key){return mutate(actor,'place',input,key,async(tx,current)=>{
      only(input,['name','kind','parentId']);const name=text(input.name,'Place name');
      const kind=input.kind || 'city';invariant(['department','city','district','village'].includes(kind),'INVALID_INPUT','Invalid place type.');
      if(input.parentId)uuid(input.parentId);
      const place=await row(tx,'INSERT INTO places(name,kind,parent_id,created_by) VALUES($1,$2,$3,$4) RETURNING *',[name,kind,input.parentId||null,current.id]);
      await audit(tx,current.id,'place.created',place.id,current.operator_id);return place;
    });},
    stop(actor,input,key){return mutate(actor,'stop',input,key,async(tx,current)=>{
      only(input,['name','placeId','latitude','longitude']);const name=text(input.name,'Stop name');uuid(input.placeId);
      invariant(Number.isFinite(input.latitude) && Math.abs(input.latitude)<=90 && Number.isFinite(input.longitude) && Math.abs(input.longitude)<=180,'INVALID_INPUT','Valid coordinates are required.');
      const stop=await row(tx,'INSERT INTO stops(name,place_id,latitude,longitude,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[name,input.placeId,input.latitude,input.longitude,current.id]);
      await audit(tx,current.id,'stop.created',stop.id,current.operator_id);return stop;
    });},
    vehicle(actor,input,key){return mutate(actor,'vehicle',input,key,async(tx,current)=>{
      only(input,['operatorId','registration','capacity']);const operatorId=await operatorScope(tx,current,input.operatorId);
      invariant(Number.isInteger(input.capacity) && input.capacity>=1 && input.capacity<=100,'INVALID_INPUT','Capacity must be between 1 and 100.');
      const vehicle=await row(tx,'INSERT INTO vehicles(operator_id,registration,capacity) VALUES($1,$2,$3) RETURNING *',[operatorId,text(input.registration,'Registration',40),input.capacity]);
      await audit(tx,current.id,'vehicle.created',vehicle.id,operatorId);return vehicle;
    });},
    route(actor,input,key){return mutate(actor,'route',input,key,async(tx,current)=>{
      only(input,['operatorId','name','stops']);const operatorId=await operatorScope(tx,current,input.operatorId);
      invariant(Array.isArray(input.stops) && input.stops.length>=2 && input.stops.length<=100,'INVALID_JOURNEY','A route needs 2–100 ordered stops.');
      journeySegments(0,input.stops.length-1,input.stops.length);
      const ids=input.stops.map(s=>uuid(s.stopId));invariant(new Set(ids).size===ids.length,'INVALID_JOURNEY','Route stops cannot repeat.');
      for(const [sequence,s] of input.stops.entries()){
        only(s,['stopId','fareToNext']);invariant(Number.isInteger(s.fareToNext) && s.fareToNext>=0 && s.fareToNext<=1_000_000 && (sequence!==ids.length-1 || s.fareToNext===0),'INVALID_FARE','Each segment needs a valid XOF fare; the terminal fare is zero.');
      }
      const route=await row(tx,'INSERT INTO routes(operator_id,name) VALUES($1,$2) RETURNING *',[operatorId,text(input.name,'Route name',200)]);
      for(const [sequence,s] of input.stops.entries())await tx.query('INSERT INTO route_stops(route_id,sequence,stop_id,fare_to_next) VALUES($1,$2,$3,$4)',[route.id,sequence,s.stopId,s.fareToNext]);
      await audit(tx,current.id,'route.created',route.id,operatorId,{stopCount:ids.length});
      // Each published segment fare opens a new historical period for that OD
      // pair: the previous fare stays in history, the new one is current.
      const operatorType=(await row(tx,'SELECT type FROM operators WHERE id=$1',[operatorId]))?.type ?? null;
      for(const [sequence,s] of input.stops.entries()){
        if(sequence===input.stops.length-1)continue;
        await fares.recordPublished(tx,{operatorId,originStopId:s.stopId,destinationStopId:input.stops[sequence+1].stopId,
          routeId:route.id,segmentSequence:sequence,fareType:'passenger',priceMinor:s.fareToNext,
          operatorType,sourceType:'leroutier_published',sourceReference:`route:${route.id}:${sequence}`});
      }
      return route;
    });},
    service(actor,input,key){return mutate(actor,'service',input,key,async(tx,current)=>{
      only(input,['routeId','vehicleId','driverId','departureAt','convoyeurId','departurePointId','arrivalPointId']);
      uuid(input.routeId);uuid(input.vehicleId);uuid(input.driverId);
      if(input.convoyeurId)uuid(input.convoyeurId);
      if(input.departurePointId)uuid(input.departurePointId);
      if(input.arrivalPointId)uuid(input.arrivalPointId);
      const departure=Date.parse(input.departureAt);invariant(Number.isFinite(departure) && departure>Date.now(),'INVALID_DEPARTURE','Departure must be in the future.');
      const route=await row(tx,'SELECT * FROM routes WHERE id=$1 AND active=true FOR SHARE',[input.routeId]);
      invariant(route,'NOT_FOUND','Route not found.',404);await operatorScope(tx,current,route.operator_id);
      // Operational safety: only verified operators run services.
      const verOp=await row(tx,'SELECT verification_status FROM operators WHERE id=$1',[route.operator_id]);
      invariant(verOp && verOp.verification_status==='verified','OPERATOR_NOT_VERIFIED','Operator verification is required before running services.',403);
      const vehicle=await row(tx,"SELECT * FROM vehicles WHERE id=$1 AND status='active' FOR UPDATE",[input.vehicleId]);
      invariant(vehicle && vehicle.operator_id===route.operator_id,'FORBIDDEN','Vehicle does not belong to this operator.',403);
      const driver=await row(tx,`SELECT d.* FROM driver_profiles d JOIN users u ON u.id=d.user_id WHERE d.user_id=$1 AND d.active=true
        AND u.active=true AND u.role='driver' AND u.operator_id=d.operator_id FOR UPDATE OF d,u`,[input.driverId]);
      invariant(driver && driver.operator_id===route.operator_id,'FORBIDDEN','Driver is not active for this operator.',403);
      let convoyeur=null;
      if(input.convoyeurId){
        convoyeur=await row(tx,`SELECT c.* FROM convoyeur_profiles c JOIN users u ON u.id=c.user_id WHERE c.user_id=$1 AND c.active=true
          AND u.active=true AND u.role='convoyeur' AND u.operator_id=c.operator_id FOR UPDATE OF c,u`,[input.convoyeurId]);
        invariant(convoyeur && convoyeur.operator_id===route.operator_id,'FORBIDDEN','Convoyeur is not active for this operator.',403);
      }
      if(input.departurePointId){
        const point=await row(tx,"SELECT * FROM boarding_points WHERE id=$1 AND status='verified'",[input.departurePointId]);
        invariant(point,'INVALID_POINT','Boarding point is not a verified location.',409);
      }
      if(input.arrivalPointId){
        const point=await row(tx,"SELECT * FROM boarding_points WHERE id=$1 AND status='verified'",[input.arrivalPointId]);
        invariant(point,'INVALID_POINT','Arrival point is not a verified location.',409);
      }
      const stops=(await tx.query('SELECT * FROM route_stops WHERE route_id=$1 ORDER BY sequence',[route.id])).rows;
      invariant(stops.length>=2 && stops.every((s,i)=>s.sequence===i),'INVALID_JOURNEY','Route order is incomplete.');
      invariant(!await row(tx,'SELECT id FROM service_assignments WHERE ended_at IS NULL AND (vehicle_id=$1 OR driver_id=$2)',[vehicle.id,driver.user_id]),'ASSIGNMENT_CONFLICT','Vehicle or driver already has an open assignment.',409);
      const service=await row(tx,'INSERT INTO services(route_id,operator_id,departure_at,capacity,departure_point_id,arrival_point_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [route.id,route.operator_id,new Date(departure),vehicle.capacity,input.departurePointId??null,input.arrivalPointId??null]);
      await tx.query('INSERT INTO service_stops(service_id,sequence,stop_id) SELECT $1,sequence,stop_id FROM route_stops WHERE route_id=$2',[service.id,route.id]);
      await tx.query('INSERT INTO service_segments(service_id,sequence,fare_minor) SELECT $1,sequence,fare_to_next FROM route_stops WHERE route_id=$2 AND sequence<$3',[service.id,route.id,stops.length-1]);
      await tx.query('INSERT INTO service_seats(service_id,seat_number) SELECT $1,generate_series(1,$2::integer)',[service.id,vehicle.capacity]);
      await tx.query('INSERT INTO service_assignments(service_id,vehicle_id,driver_id,convoyeur_id) VALUES($1,$2,$3,$4)',[service.id,vehicle.id,driver.user_id,convoyeur?.user_id??null]);
      await audit(tx,current.id,'service.provisioned',service.id,route.operator_id,{convoyeurId:convoyeur?.user_id??null});return service;
    });},
  };
}

export async function bootstrap(db,input){
  only(input,['operatorKey','operatorName','opsSubject','opsName','issuer','platformOps','driver']);
  const operatorKey=text(input.operatorKey,'Operator key',60),operatorName=text(input.operatorName,'Operator name');
  invariant(/^[a-z0-9-]+$/.test(operatorKey),'INVALID_INPUT','Use a lowercase operator key.');
  const opsSubject=text(input.opsSubject,'Ops identity subject',255),opsName=text(input.opsName,'Ops name'),issuer=text(input.issuer,'Configured issuer',500);
  invariant(input.platformOps===undefined || typeof input.platformOps==='boolean','INVALID_INPUT','Invalid platform choice.');
  const fingerprint=hash(input);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['leroutier-bootstrap']);
    const prior=await row(tx,'SELECT * FROM bootstrap_receipt');
    if(prior){invariant(prior.fingerprint===fingerprint,'BOOTSTRAP_CONFLICT','Bootstrap already completed with different inputs.',409);return {operatorId:prior.operator_id,opsUserId:prior.ops_user_id};}
    invariant(!await row(tx,"SELECT id FROM users WHERE role='ops' AND is_demo=false"),'BOOTSTRAP_CLOSED','Privileged users already exist; use authorized provisioning.',409);
    // The one-time bootstrap is a reviewed human action: the operator starts
    // verified. Self-service onboarding starts pending_verification instead.
    const operator=await row(tx,"INSERT INTO operators(name,provisioning_key,verification_status) VALUES($1,$2,'verified') RETURNING id",[operatorName,operatorKey]);
    let user=await row(tx,'SELECT * FROM users WHERE auth_subject=$1 FOR UPDATE',[opsSubject]);
    if(user)invariant(user.auth_issuer===issuer && user.role==='passenger' && user.active,'IDENTITY_CONFLICT','Bootstrap identity is not eligible.',409);
    const operatorId=input.platformOps?null:operator.id;
    user=user?await row(tx,"UPDATE users SET role='ops',operator_id=$2,display_name=$3,profile_completed_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[user.id,operatorId,opsName]):
      await row(tx,"INSERT INTO users(auth_subject,auth_issuer,display_name,role,operator_id,profile_completed_at) VALUES($1,$2,$3,'ops',$4,now()) RETURNING *",[opsSubject,issuer,opsName,operatorId]);
    await audit(tx,null,'operator.bootstrapped',operator.id,operator.id);
    await audit(tx,null,'identity.ops_bootstrapped',user.id,operatorId,{platformOps:!!input.platformOps});
    if(input.driver)await provisionUser(tx,user,{...input.driver,operatorId:operator.id},'driver',issuer);
    await tx.query('INSERT INTO bootstrap_receipt(fingerprint,operator_id,ops_user_id) VALUES($1,$2,$3)',[fingerprint,operator.id,user.id]);
    return {operatorId:operator.id,opsUserId:user.id};
  });
}
