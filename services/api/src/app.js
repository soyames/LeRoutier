import { randomUUID } from 'node:crypto';
import { DomainError, invariant, uuid } from '@leroutier/domain';
import { transport } from '@leroutier/database/transport';
import { validatePosition } from '@leroutier/geo';
import { enqueue } from '@leroutier/notifications';
import { authentication } from './auth.js';
import { publicAuthConfig } from '@leroutier/config';
import { updateProfile } from '@leroutier/database/identities';
import { provisioning } from '@leroutier/database/provisioning';
import { payments } from '@leroutier/database/payments';
import { tickets } from '@leroutier/database/tickets';
import { driverAction, recordIncident } from '@leroutier/database/driver-actions';
import { earnings, payouts } from '@leroutier/database/payouts';
import { recovery } from '@leroutier/database/recovery';
import { parcels } from '@leroutier/database/parcels';
import { paymentAdapter } from './payment-adapter.js';
import { authenticate as authenticateAgent, catalog, createActions, createWorkflowEngine } from '@leroutier/agents';

const API_PREFIX = '/api/v1';

export function createApi(db, config, keyResolver=undefined, adapter=paymentAdapter(config)) {
  const domain=transport(db), auth=authentication(db,config,keyResolver),provision=provisioning(db,config);
  const pay=payments(db,adapter),ticket=tickets(db);
  const earn=earnings(db),payout=payouts(db,adapter,config),recover=recovery(db),parcel=parcels(db);
  const actions=createActions({db,domain,payments:pay,payouts:payout,recovery:recover,parcels:parcel});
  const workflows=createWorkflowEngine({db,actions});
  const list=(query,params=[])=>db.transaction(async tx=>(await tx.query(query,params)).rows);
  async function limited(subject) {
    await db.transaction(async tx=>{
      const {rows}=await tx.query(`INSERT INTO request_limits(subject,window_at,requests) VALUES($1,date_trunc('minute',now()),1)
        ON CONFLICT(subject,window_at) DO UPDATE SET requests=request_limits.requests+1 RETURNING requests`,[subject]);
      invariant(rows[0].requests<=120,'RATE_LIMITED','Too many requests. Try again shortly.',429);
    });
  }
  function body(req){
    return async()=>{
      invariant((req.headers.get('content-type') || '').includes('application/json'),'INVALID_BODY','JSON is required.');
      const text=await req.text();
      invariant(text.length<=16_384,'INVALID_BODY','Request is too large.',413);
      try { const b=JSON.parse(text);invariant(b && typeof b==='object' && !Array.isArray(b),'INVALID_BODY','An object is required.');return b; }
      catch { throw new DomainError('INVALID_BODY','Invalid JSON.'); }
    };
  }
  async function route(req,path,url,method,readBody){
    const body=readBody;
    if(method==='GET' && path==='/health') {await list('SELECT 1');return {status:'ok'};}
    if(method==='GET' && path==='/auth/config') return publicAuthConfig(config);
    if(method==='GET' && path==='/payments/config') return {available:pay.configured};
    // Public parcel tracking: safe projection only — no parties, phones or
    // payment data, ever. Rate limited per client address.
    const publicTracking=path.match(/^\/public\/parcel-tracking\/(LRP-[0-9A-Fa-f]{8})$/);
    if(method==='GET' && publicTracking) {await limited('public-tracking:'+((req.headers.get('x-forwarded-for')||'').split(',')[0]||'local'));return parcel.publicTracking(publicTracking[1]);}
    // Dedicated LeRoutier FedaPay webhook. Signature is verified exactly per
    // FedaPay's official spec before anything is correlated or mutated;
    // uncorrelatable events are safely ignored with a 200 response.
    if(method==='POST' && path==='/webhooks/fedapay'){
      invariant(adapter && adapter.name==='fedapay','PAYMENT_UNAVAILABLE','Payment integration is unavailable.',503);
      const raw=await req.text();
      invariant(raw.length<=16384,'INVALID_BODY','Webhook is too large.',413);
      const event=await adapter.verifyEvent(raw,req.headers);
      if(!event)return {ignored:true};
      try{
        if(event.kind==='payout')return await payout.applyEvent(event);
        return await pay.applyEvent(event);
      }catch(error){
        const anomaly=['PAYMENT_MISMATCH','DUPLICATE_REFERENCE','EVENT_CONFLICT','PAYMENT_TRANSITION','NOT_FOUND'].includes(error.code);
        if(!anomaly)throw error;
        const ids=/** @type {{payoutRequestId?:string,paymentId?:string}} */(event);
        await db.transaction(async tx=>{
          const type=ids.payoutRequestId?'payout.anomaly':'payment.anomaly';
          const aggregate=ids.payoutRequestId ?? ids.paymentId ?? randomUUID();
          await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',[type,aggregate,JSON.stringify({
            ...(ids.payoutRequestId?{payoutRequestId:ids.payoutRequestId}:{paymentId:ids.paymentId}),
            reference:event.reference,code:error.code})]);
        });
        return {ignored:true,anomaly:true};
      }
    }
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
    // Human users authenticate first; service/agent principals (distinct identity
    // namespace) only apply to the dedicated agent API below.
    const human=await auth.authenticate(req).catch(error=>error);
    const agent=human instanceof DomainError ? await authenticateAgent(db,req) : null;
    if(human instanceof DomainError && !agent) throw human;
    const actor=agent ?? human;
    if(method!=='GET') await limited(actor.id ?? actor.agent.id);
    if(actor.agent && !path.startsWith('/agent/') && !(method==='POST' && path==='/workflows/tick'))
      invariant(false,'FORBIDDEN','Agent principals can only use the agent API.',403);
    if(method==='GET' && path==='/me') return actor.agent ? {agent:actor.agent} : actor;
    if(method==='GET' && path==='/agent/me') {
      invariant(actor.agent,'FORBIDDEN','Agent authentication is required.',403);
      return {principal:{id:actor.agent.id,name:actor.agent.name,scopes:actor.agent.scopes,operatorId:actor.agent.operatorId},actions:catalog(actions,actor.agent)};
    }
    if(method==='GET' && path==='/agent/actions') {
      invariant(actor.agent,'FORBIDDEN','Agent authentication is required.',403);
      return catalog(actions,actor.agent);
    }
    const agentAction=path.match(/^\/agent\/actions\/([a-z0-9_.-]+)\/run$/);
    if(method==='POST' && agentAction) {
      invariant(actor.agent,'FORBIDDEN','Agent authentication is required.',403);
      return workflows.runAction(actor.agent,agentAction[1],await body(),req.headers.get('idempotency-key') ?? undefined);
    }
    if(method==='GET' && path==='/agent/approvals') {
      invariant(actor.role==='ops','FORBIDDEN','Operations access required.',403);
      return workflows.listApprovals(actor);
    }
    const agentApproval=path.match(/^\/agent\/approvals\/([^/]+)$/);
    if(method==='POST' && agentApproval) {
      invariant(actor.role==='ops','FORBIDDEN','Operations access required.',403);
      const input=await body();
      invariant(input && Object.keys(input).every(k=>['decision','input'].includes(k)),'INVALID_DECISION','Unexpected approval fields.');
      return workflows.approve(actor,uuid(agentApproval[1]),input.decision,input.input);
    }
    if(method==='GET' && path==='/workflows') {
      invariant(actor.role==='ops','FORBIDDEN','Operations access required.',403);
      return workflows.listRuns(actor);
    }
    const workflowRetry=path.match(/^\/workflows\/([^/]+)\/retry$/);
    if(method==='POST' && workflowRetry) {
      invariant(actor.role==='ops','FORBIDDEN','Operations access required.',403);
      return workflows.retry(actor,uuid(workflowRetry[1]));
    }
    if(method==='POST' && path==='/workflows/tick') {
      invariant(actor.agent && actor.agent.scopes.includes('workflow.run'),'FORBIDDEN','Agent scope workflow.run is required.',403);
      return workflows.processOutbox();
    }
    if(method==='POST' && path==='/tickets/verify')return ticket.verify(actor,await body());
    if(method==='POST' && path==='/driver/actions')return driverAction(db,actor,await body(),req.headers.get('idempotency-key'));
    if(method==='GET' && path==='/driver/earnings') {
      invariant(actor.role==='driver','FORBIDDEN','Driver access required.',403);
      return {summary:await earn.summary(actor),entries:await earn.ledger(actor)};
    }
    if(method==='GET' && path==='/driver/payout-destinations') return payout.destinations(actor);
    if(method==='POST' && path==='/driver/payout-destinations') return payout.addDestination(actor,await body());
    if(method==='GET' && path==='/driver/payouts') return payout.list(actor);
    if(method==='POST' && path==='/driver/payouts') return payout.request(actor,await body(),req.headers.get('idempotency-key'));
    const payoutCancel=path.match(/^\/driver\/payouts\/([^/]+)\/cancel$/);
    if(method==='POST' && payoutCancel) return payout.cancel(actor,uuid(payoutCancel[1]));
    if(method==='GET' && path==='/ops/payments') {
      invariant(actor.role==='ops','FORBIDDEN','Operations access required.',403);
      return pay.listOps(actor,{status:url.searchParams.get('status') ?? undefined});
    }
    const opsReconcile=path.match(/^\/ops\/payments\/([^/]+)\/reconcile$/);
    if(method==='POST' && opsReconcile) return pay.reconcile(actor,uuid(opsReconcile[1]));
    if(method==='GET' && path==='/ops/payouts') {
      invariant(actor.role==='ops','FORBIDDEN','Operations access required.',403);
      return payout.listOps(actor,{status:url.searchParams.get('status') ?? undefined});
    }
    const opsApprove=path.match(/^\/ops\/payouts\/([^/]+)\/approve$/);
    if(method==='POST' && opsApprove) return payout.approve(actor,uuid(opsApprove[1]));
    const opsPayoutReconcile=path.match(/^\/ops\/payouts\/([^/]+)\/reconcile$/);
    if(method==='POST' && opsPayoutReconcile) return payout.reconcile(actor,uuid(opsPayoutReconcile[1]));
    // --- Parcel Logistics v1 (all routes versioned under /api/v1) ---
    if(method==='GET' && path==='/parcels/quote') {
      const weightG=url.searchParams.get('weightG'),declared=url.searchParams.get('declaredValueMinor');
      return parcel.quote(actor,{originStopId:url.searchParams.get('originStopId'),destinationStopId:url.searchParams.get('destinationStopId'),
        category:url.searchParams.get('category'),...(weightG?{weightG:Number(weightG)}:{}),...(declared?{declaredValueMinor:Number(declared)}:{}),
        ...(url.searchParams.get('operatorId')?{operatorId:url.searchParams.get('operatorId')}:{})});
    }
    if(method==='POST' && path==='/parcels') return parcel.create(actor,await body(),req.headers.get('idempotency-key'));
    if(method==='GET' && path==='/me/parcels') return parcel.listMine(actor);
    if(method==='GET' && path==='/driver/parcels') return parcel.listDriver(actor);
    if(method==='GET' && path==='/ops/parcels') return parcel.listOps(actor,{status:url.searchParams.get('status')??undefined,q:url.searchParams.get('q')??undefined});
    if(method==='GET' && path==='/ops/parcel-rate-rules') return parcel.rateRules(actor);
    if(method==='POST' && path==='/ops/parcel-rate-rules') return parcel.rateRules(actor,await body(),req.headers.get('idempotency-key'));
    const parcelPath=path.match(/^\/parcels\/([^/]+)(?:\/(label|events|accept|assign|scan|ready|pickup-code|pickup|exceptions|cancel|payments))?$/);
    if(parcelPath){
      const id=parcelPath[1],action=parcelPath[2];
      if(!action && method==='GET') return parcel.get(actor,id);
      if(action==='label' && method==='GET') return parcel.label(actor,id);
      if(action==='events' && method==='GET') return parcel.events(actor,id);
      if(action==='accept' && method==='POST') return parcel.accept(actor,id);
      if(action==='assign' && method==='POST') return parcel.assign(actor,id,await body());
      if(action==='scan' && method==='POST') return parcel.scan(actor,id,await body(),req.headers.get('idempotency-key'));
      if(action==='ready' && method==='POST') return parcel.ready(actor,id);
      if(action==='pickup-code' && method==='POST') return parcel.issuePickupCode(actor,id);
      if(action==='pickup' && method==='POST') return parcel.collect(actor,id,await body());
      if(action==='exceptions' && method==='POST') return parcel.exception(actor,id,await body());
      if(action==='cancel' && method==='POST') return parcel.cancel(actor,id);
      if(action==='payments' && method==='POST') return parcel.recordPayment(actor,id,await body(),req.headers.get('idempotency-key'));
    }
    const ticketPath=path.match(/^\/bookings\/([^/]+)\/ticket$/);
    if(method==='POST' && ticketPath)return ticket.issue(actor,uuid(ticketPath[1]));
    const paymentPath=path.match(/^\/bookings\/([^/]+)\/(payment-intents|payment-status|reconcile-manual)$/);
    if(paymentPath){
      const id=uuid(paymentPath[1]);
      if(method==='GET' && paymentPath[2]==='payment-status')return pay.status(actor,id);
      if(method==='POST' && paymentPath[2]==='payment-intents')return pay.initiate(actor,id,await body(),req.headers.get('idempotency-key'));
      if(method==='POST' && paymentPath[2]==='reconcile-manual')return pay.manual(actor,id,await body(),req.headers.get('idempotency-key'));
    }
    const reconcile=path.match(/^\/payments\/([^/]+)\/reconcile$/);
    if(method==='POST' && reconcile)return pay.reconcile(actor,uuid(reconcile[1]));
    if(method==='PATCH' && path==='/me') return updateProfile(db,actor,await body());
    if(method==='GET' && path==='/ops/provisioning') return provision.catalog(actor);
    const provisionPath=path.match(/^\/ops\/(operators|drivers|ops-users|places|stops|vehicles|routes|services)$/);
    if(method==='POST' && provisionPath) {
      const operations={operators:'operator',drivers:'driver','ops-users':'opsUser',places:'place',stops:'stop',vehicles:'vehicle',routes:'route',services:'service'};
      return provision[operations[provisionPath[1]]](actor,await body(),req.headers.get('idempotency-key'));
    }
    const activation=path.match(/^\/ops\/users\/([^/]+)\/status$/);
    if(method==='PATCH' && activation) return provision.userStatus(actor,uuid(activation[1]),await body(),req.headers.get('idempotency-key'));
    if(method==='POST' && path==='/bookings') {
      invariant(!actor.needs_profile,'PROFILE_REQUIRED','Complete your passenger profile before booking.',409);
      return domain.hold(actor,await body(),req.headers.get('idempotency-key'));
    }
    if(method==='GET' && path==='/me/bookings') return domain.passengerBookings(actor);
    const booking=path.match(/^\/bookings\/([^/]+)(?:\/(confirm|cancel|board|alight|payments))?$/);
    if(booking) {
      const id=uuid(booking[1]),action=booking[2];
      if(method==='GET' && !action) return domain.booking(actor,id);
      if(method==='POST' && action==='payments') return domain.recordPayment(actor,id,await body(),req.headers.get('idempotency-key'));
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
          await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',['service.position',id,JSON.stringify({serviceId:id,observedAt:input.observedAt})]);
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
      if(method==='POST' && action==='recovery') return recover.assign(actor,{...await body(),serviceId:id});
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
      return recordIncident(db,actor,await body());
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
  return async req=>{
    const origin=req.headers.get('origin');
    const allowed=!origin || config.corsOrigins.includes(origin);
    const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','vary':'Origin'};
    if(origin && allowed) headers['access-control-allow-origin']=origin;
    const url=new URL(req.url);
    const rawPath=url.pathname.replace(/\/$/,'')||'/';
    // API versioning: the transport contract is versioned, the domain is not.
    // Unversioned paths are temporary compatibility aliases of /api/v1 that run
    // the exact same handler and are marked deprecated on every response.
    const legacy=!rawPath.startsWith(API_PREFIX);
    const path=(legacy?API_PREFIX+rawPath:rawPath).replace(API_PREFIX,'')||'/';
    try {
      invariant(allowed,'FORBIDDEN','Origin is not allowed.',403);
      if(req.method==='OPTIONS') return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':'GET,POST,PATCH,OPTIONS','access-control-allow-headers':'Authorization,Content-Type,Idempotency-Key'}});
      const data=await route(req,path,url,req.method,body(req));
      if(legacy){headers.deprecation='true';headers.sunset='2026-12-31T23:59:59Z';}
      return new Response(JSON.stringify({data}),{headers});
    } catch(error) {
      const known=error instanceof DomainError;
      const conflict=['23505','23514','23503'].includes(error.code);
      const status=known?error.status:conflict?409:503;
      if(legacy && status!==404){headers.deprecation='true';headers.sunset='2026-12-31T23:59:59Z';}
      return new Response(JSON.stringify({error:{code:known?error.code:conflict?'CONFLICT':'INTERNAL_ERROR',message:known?error.message:conflict?'The operation conflicts with current data.':'The service is temporarily unavailable.',requestId:randomUUID()}}),{status,headers});
    }
  };
}
