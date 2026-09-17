import { randomUUID } from 'node:crypto';
import { DomainError, invariant, uuid } from '@leroutier/domain';
import { transport } from '@leroutier/database/transport';
import { validateVehiclePosition, distanceMetres } from '@leroutier/geo';
import { enqueue, channelAvailability } from '@leroutier/notifications';
import { authentication } from './auth.js';
import { publicAuthConfig } from '@leroutier/config';
import { updateProfile, audit } from '@leroutier/database/identities';
import { provisioning } from '@leroutier/database/provisioning';
import { payments } from '@leroutier/database/payments';
import { tickets } from '@leroutier/database/tickets';
import { driverAction, recordIncident } from '@leroutier/database/driver-actions';
import { earnings, payouts } from '@leroutier/database/payouts';
import { recovery } from '@leroutier/database/recovery';
import { parcels } from '@leroutier/database/parcels';
import { onboarding } from '@leroutier/database/onboarding';
import { locations } from '@leroutier/database/locations';
import { operatorSettlements } from '@leroutier/database/operator-settlements';
import { walkUpBookings } from '@leroutier/database/walkup';
import { notificationPolicies } from '@leroutier/database/notifications';
import { notificationDelivery } from '@leroutier/database/notification-delivery';
import { operationalHealth } from '@leroutier/database/operational-health';
import { fareIntelligence } from '@leroutier/database/fare-intelligence';
import { commercial } from '@leroutier/database/commercial';
import { assistantService } from './assistant.js';
import { privacyCenter, retentionEngine } from '@leroutier/database/privacy';
import { journeyPlanning } from '@leroutier/database/journey-planning';
import { mobility } from '@leroutier/database/mobility';
import { journeys } from '@leroutier/database/journeys';
import { tracking } from '@leroutier/database/tracking';
import { routeGeometry } from '@leroutier/database/route-geometry';
import { createRouter } from '@leroutier/routing';
import { paymentAdapter } from './payment-adapter.js';
import { authenticate as authenticateAgent, catalog, createActions, createWorkflowEngine, createModelProvider, createReasoning, databaseCooldownStore } from '@leroutier/agents';
import { createUssdEngine, adapterFor as ussdAdapterFor } from '@leroutier/ussd';

const API_PREFIX = '/api/v1';

/** A body that is not the JSON envelope — currently only the USSD gateway. */
class RawResponse {
  constructor(body, contentType) { this.body = body; this.contentType = contentType; }
}

export function createApi(db, config, keyResolver=undefined, adapter=paymentAdapter(config)) {
  const health=operationalHealth(db);
  const fares=fareIntelligence(db);
  const commerce=commercial(db);
  const domain=transport(db), auth=authentication(db,config,keyResolver),provision=provisioning(db,config);
  const pay=payments(db,adapter),ticket=tickets(db);
  const earn=earnings(db),payout=payouts(db,adapter,config),recover=recovery(db),parcel=parcels(db);
  const onboard=onboarding(db),loc=locations(db),settle=operatorSettlements(db,adapter),walkUp=walkUpBookings(db);
  const notify=notificationPolicies(db,config),rides=mobility(db),journey=journeys(db,config);
  const router=createRouter(config),geometry=routeGeometry(db,router),track=tracking(db,config);
  const actions=createActions({db,domain,payments:pay,payouts:payout,recovery:recover,parcels:parcel});
  // Model-assisted triage. Optional by construction: with no provider
  // configured every call reports unavailable and the deterministic paths are
  // unchanged, which is what keeps this an improvement rather than a dependency.
  // Validated against the real executable catalog, not a copy of it: a model
  // proposing an action LeRoutier no longer has must fail, not drift.
  // The cooldown store is shared through the database on purpose: this API is
  // serverless, so a window remembered only in one instance is forgotten the
  // moment it recycles, and the next cold instance calls a provider that has
  // already refused.
  const reasoning=createReasoning({db,actions,budget:config.model?.budget,
    provider:createModelProvider(config,fetch,{cooldownStore:databaseCooldownStore(db)})});
  // The engine is given `reasoning`, not a provider: only the one workflow that
  // triages incidents may ask a model anything, and only through the budget,
  // projection and validation that createReasoning wraps around it.
  const workflows=createWorkflowEngine({db,actions,onEvent:(tx,event)=>notify.dispatchEvent(tx,event),
    autonomy:config.agentAutonomy,reasoning,triage:config.model?.triage??{}});
  // USSD is a channel over these same services — not a second backend. It is
  // handed the very objects every other route uses, so a capacity check or a
  // fare it sees is the one the PWA sees.
  const ussd=createUssdEngine({db,domain,parcels:parcel,payments:pay,tracking:track,config:config.ussd ?? {}});
  const privacy=privacyCenter(db);
  const retention=retentionEngine(db);
  const planner=journeyPlanning(db,{boardingBufferS:config.journey?.boardingBufferS ?? 600});
  const assistant=assistantService({db,domain,parcels:parcel,fares,health,track,privacy});
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
    // A known path with an unsupported method is a method error before any
    // other check: no accidental GET mutation, no silent typo confusion, and
    // no auth-oracle ordering difference between public and private routes.
    const METHOD_ALLOW = {
      '/health': ['GET'], '/auth/config': ['GET'], '/payments/config': ['GET'],
      '/stops': ['GET'], '/places': ['GET'], '/routes': ['GET'], '/services': ['GET'],
      '/webhooks/fedapay': ['POST'], '/auth/demo': ['POST'], '/me': ['GET', 'PATCH'],
      '/me/bookings': ['GET'], '/me/parcels': ['GET'], '/notifications': ['GET'],
      '/notifications/preferences': ['GET', 'PUT'], '/parcels/quote': ['GET'], '/parcels': ['POST'],
      '/bookings': ['POST'], '/operator/settlements': ['GET'], '/operator/payouts': ['GET', 'POST'],
      '/driver/earnings': ['GET'], '/driver/parcels': ['GET'], '/driver/service': ['GET'],
      '/driver/payouts': ['GET', 'POST'], '/driver/payout-destinations': ['GET', 'POST'],
      '/driver/walk-up-bookings': ['POST'], '/driver/actions': ['POST'],
      '/onboarding/me': ['GET'], '/onboarding/company': ['POST'], '/onboarding/independent': ['POST'],
      '/onboarding/operator': ['PATCH'], '/operators': ['GET'], '/incidents': ['GET', 'POST'],
      '/boarding-points': ['GET'], '/boarding-points/proposals': ['POST'], '/mobility/providers': ['GET'],
      '/mobility/handoff': ['POST'], '/tickets/verify': ['POST'], '/workflows': ['GET'],
      '/workflows/tick': ['POST'], '/assistant': ['POST'],
    };
    if (METHOD_ALLOW[path] && !METHOD_ALLOW[path].includes(method)) {
      throw new DomainError('METHOD_NOT_ALLOWED', 'Method not allowed for this endpoint.', 405);
    }
    if(method==='GET' && path==='/health') {await list('SELECT 1');return {status:'ok'};}
    if(method==='GET' && path==='/auth/config') return publicAuthConfig(config);
    if(method==='GET' && path==='/payments/config') return {available:pay.configured,payouts:{available:!!(adapter && adapter.payoutsAvailable)}};
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
        if(event.kind==='payout'){
          try{return await payout.applyEvent(event);}
          catch(payoutError){
            // Driver payouts first; operator-settlement payouts share the same
            // provider metadata namespace and fall through safely.
            if(payoutError.code!=='NOT_FOUND')throw payoutError;
            return await settle.applyEvent(event);
          }
        }
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
    // USSD gateway callback. Public by necessity — a telecom gateway carries no
    // LeRoutier session — so it is protected by provider verification, a size
    // cap, a per-caller throttle inside the engine, and replay suppression.
    // It is never a generic execution surface: the only thing a caller can do
    // is advance a menu.
    const ussdCallback=path.match(/^\/ussd\/webhook\/([a-z0-9-]{1,32})$/);
    if(method==='POST' && ussdCallback) {
      const name=ussdCallback[1];
      // A provider that is not the configured one is refused outright, so a
      // deployment cannot accidentally expose the never-verifying sandbox.
      invariant(config.ussd?.provider && name===config.ussd.provider,'NOT_FOUND','Endpoint not found.',404);
      const adapter=ussdAdapterFor(name);
      invariant(adapter,'NOT_FOUND','Endpoint not found.',404);
      const raw=await req.text();
      invariant(raw.length<=8192,'INVALID_BODY','Request is too large.',413);
      const verified=adapter.verify(raw,req.headers,config.ussd.webhookSecret);
      // An unverified callback is still answered — a gateway must not be left
      // hanging — but it can never bind an identity or reach a booking.
      let parsed;
      try { parsed=adapter.parse(raw.trim().startsWith('{')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))); }
      catch { throw new DomainError('INVALID_BODY','Invalid USSD callback.'); }
      await limited('ussd:'+name+':'+(parsed.sessionId||'anonymous'));
      const result=await ussd.handle({...parsed,provider:name,verified:verified===true});
      const rendered=adapter.render(result);
      // Gateways speak plain text, not the JSON envelope every other route
      // uses. RawResponse carries it out without losing the security headers.
      return new RawResponse(rendered.body,rendered.contentType);
    }
    if(method==='POST' && path==='/auth/demo') {invariant(config.demoLogin,'NOT_FOUND','Endpoint not found.',404);await limited('demo-login');return auth.demoSession((await body()).role);}
    // The public catalogue is the one authenticated-free read surface with real
    // breadth: every stop, every place, every route, every departure. Without a
    // limit it is a free scraping and enumeration endpoint, so anonymous reads
    // are metered per client address exactly as public parcel tracking is.
    // Authenticated traffic is metered per identity further down.
    const meterAnonymous=()=>limited('public-catalogue:'+((req.headers.get('x-forwarded-for')||'').split(',')[0].trim()||'local'));
    if(method==='GET' && ['/stops','/places','/routes','/services'].includes(path)) await meterAnonymous();
    // Door-to-destination journey planning over the existing service domain.
    // The passenger's exact current coordinates are transient: used only to
    // resolve the first mile, never stored and never exposed to operators.
    if(method==='GET' && path==='/journey-plan') {
      const q = url.searchParams;
      const origin = q.has('lat') && q.has('lon') ? { latitude: Number(q.get('lat')), longitude: Number(q.get('lon')) } : null;
      return planner.plan({
        originStopId: q.get('originStopId'), origin,
        destinationStopId: q.get('destinationStopId'),
        destination: q.has('destLat') && q.has('destLon') ? { latitude: Number(q.get('destLat')), longitude: Number(q.get('destLon')) } : null,
        departureAt: q.get('departureAt'),
      });
    }
    if(method==='GET' && path==='/stops') {
      const search=(url.searchParams.get('q') || '').slice(0,100);
      return list(`SELECT s.*,p.name AS city FROM stops s JOIN places p ON p.id=s.place_id
        WHERE s.name ILIKE $1 OR p.name ILIKE $1 ORDER BY p.name,s.name LIMIT 100`,['%'+search+'%']);
    }
    // Canonical Benin geography: search across names, normalized names and
    // common spelling aliases; `type` filters (department, commune rows —
    // communes are cities under a department).
    if(method==='GET' && path==='/places') {
      const q=(url.searchParams.get('q')||'').slice(0,100);
      const type=url.searchParams.get('type');
      invariant(type===null || ['department','city','commune'].includes(type),'INVALID_INPUT','Invalid place type.');
      const kindFilter=type==='commune'
        ? `kind='city' AND parent_id IN (SELECT id FROM places WHERE kind='department')`
        : type ? `kind='${type}'` : 'TRUE';
      if(q) return list(`SELECT id,name,kind,parent_id,latitude,longitude FROM places
        WHERE (name ILIKE $1 OR normalized_name ILIKE $2 OR aliases::text ILIKE $2) AND ${kindFilter}
        ORDER BY (kind='city') DESC, name LIMIT 100`,[`%${q}%`,`%${q.toLowerCase()}%`]);
      return list(`SELECT id,name,kind,parent_id,latitude,longitude FROM places
        WHERE ${kindFilter} ORDER BY name LIMIT 200`);
    }
    if(method==='GET' && path==='/routes') return list(`SELECT r.*,coalesce((SELECT json_agg(json_build_object('sequence',rs.sequence,'stopId',s.id,'name',s.name,'city',p.name) ORDER BY rs.sequence)
      FROM route_stops rs JOIN stops s ON s.id=rs.stop_id JOIN places p ON p.id=s.place_id WHERE rs.route_id=r.id),'[]') AS stops FROM routes r WHERE active=true ORDER BY name`);
    // The same search the USSD channel runs. One query, one answer to
    // "is there a seat?", whichever client is asking.
    if(method==='GET' && path==='/services') {
      return domain.search({originStopId:url.searchParams.get('originStopId'),destinationStopId:url.searchParams.get('destinationStopId')});
    }
    const available=path.match(/^\/services\/([^/]+)\/availability$/);
    // Metered after validation: rejecting a malformed identifier must stay free,
    // or the limiter becomes its own amplifier — one bad request, one DB write.
    if(method==='GET' && available) {
      const serviceId=uuid(available[1]);
      await meterAnonymous();
      return domain.availability(serviceId,Number(url.searchParams.get('origin')),Number(url.searchParams.get('destination')));
    }
    // The Assistant is role-aware: anonymous callers get the public surface
    // only, and every caller is rate-limited per identity or per client
    // address. The identity comes from the server, never from the message.
    if(method==='POST' && path==='/assistant') {
      const assistantHuman=await auth.authenticate(req).catch(()=>null);
      const ip=(req.headers.get('x-forwarded-for')||'').split(',')[0].trim()||'local';
      await limited(assistantHuman?('assistant-user:'+assistantHuman.id):('assistant-anon:'+ip));
      const assistantInput=await body();
      invariant(assistantInput && Object.keys(assistantInput).every(k=>['sessionId','message'].includes(k)),
        'INVALID_INPUT','Unexpected assistant fields.');
      return assistant.handle({actor:assistantHuman,sessionId:assistantInput.sessionId,message:assistantInput.message,reasoning});
    }
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
      const result=await workflows.processOutbox();
      await notificationDelivery(db).tick();
      return result;
    }
    if(method==='POST' && path==='/tickets/verify')return ticket.verify(actor,await body());
    if(method==='POST' && path==='/driver/actions')return driverAction(db,actor,await body(),req.headers.get('idempotency-key'));
    // --- Onboarding & membership (one canonical operator model) ---
    if(method==='GET' && path==='/onboarding/me') return onboard.state(actor);
    if(method==='POST' && path==='/onboarding/company') return onboard.startCompany(actor,await body(),req.headers.get('idempotency-key'));
    if(method==='POST' && path==='/onboarding/independent') return onboard.startIndependent(actor,await body(),req.headers.get('idempotency-key'));
    if(method==='PATCH' && path==='/onboarding/operator') return onboard.updateProfile(actor,await body());
    if(method==='GET' && path==='/operators') return onboard.listOperators(actor);
    const operatorVerify=path.match(/^\/operators\/([^/]+)\/verification$/);
    if(method==='POST' && operatorVerify) return onboard.verification(actor,uuid(operatorVerify[1]),(await body()).decision);
    const operatorMembers=path.match(/^\/operators\/([^/]+)\/members$/);
    if(method==='GET' && operatorMembers) return onboard.members(actor,uuid(operatorMembers[1]));
    const operatorStations=path.match(/^\/operators\/([^/]+)\/stations$/);
    if(method==='GET' && operatorStations) return loc.stationList(actor,uuid(operatorStations[1]));
    if(method==='POST' && operatorStations) return loc.stationCreate(actor,{...await body(),operatorId:uuid(operatorStations[1])});
    // --- Canonical operational location registry ---
    if(method==='GET' && path==='/boarding-points') {
      const purposes=url.searchParams.get('purposes');
      return loc.search(actor,{q:url.searchParams.get('q')??undefined,placeId:url.searchParams.get('placeId')??undefined,
        purposes:purposes?purposes.split(','):undefined,includeProposed:url.searchParams.get('includeProposed')==='true'});
    }
    if(method==='POST' && path==='/boarding-points/proposals') return loc.propose(actor,await body());
    const pointModerate=path.match(/^\/boarding-points\/([^/]+)\/moderate$/);
    if(method==='POST' && pointModerate) return loc.moderate(actor,uuid(pointModerate[1]),(await body()).decision);
    const serviceCrew=path.match(/^\/services\/([^/]+)\/crew$/);
    if(method==='GET' && serviceCrew) {
      const id=uuid(serviceCrew[1]);
      return db.transaction(async tx=>{
        await domain.authorizeService(tx,actor,id,true);
        const assignment=await tx.query(`SELECT a.driver_id,a.convoyeur_id,a.vehicle_id,d.display_name AS driver_name,c.display_name AS convoyeur_name,v.registration
          FROM service_assignments a LEFT JOIN users d ON d.id=a.driver_id LEFT JOIN users c ON c.id=a.convoyeur_id
          LEFT JOIN vehicles v ON v.id=a.vehicle_id WHERE a.service_id=$1 AND a.ended_at IS NULL`,[id]);
        return assignment.rows[0]??null;
      });
    }
    // --- Walk-up cash bookings (the only cash channel, crew only) ---
    if(method==='POST' && path==='/driver/walk-up-bookings') return walkUp(actor,await body(),req.headers.get('idempotency-key'));
    // --- Operator settlements & withdrawals ---
    if(method==='GET' && path==='/operator/settlements') return {summary:await settle.summary(actor),entries:await settle.ledger(actor)};
    if(method==='GET' && path==='/operator/payouts') return settle.list(actor);
    if(method==='POST' && path==='/operator/payouts') return settle.request(actor,await body(),req.headers.get('idempotency-key'));
    const operatorPayoutCancel=path.match(/^\/operator\/payouts\/([^/]+)\/cancel$/);
    if(method==='POST' && operatorPayoutCancel) return settle.cancel(actor,uuid(operatorPayoutCancel[1]));
    if(method==='GET' && path==='/ops/operator-payouts') return settle.listOps(actor);
    const operatorPayoutApprove=path.match(/^\/ops\/operator-payouts\/([^/]+)\/approve$/);
    if(method==='POST' && operatorPayoutApprove) return settle.approve(actor,uuid(operatorPayoutApprove[1]));
    const operatorPayoutReconcile=path.match(/^\/ops\/operator-payouts\/([^/]+)\/reconcile$/);
    if(method==='POST' && operatorPayoutReconcile) return settle.reconcile(actor,uuid(operatorPayoutReconcile[1]));
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
    // Fare Intelligence is operator-only: passengers and parcel senders see
    // the final price, never the market comparison or the commission model.
    if(method==='GET' && path==='/ops/fare-intelligence') {
      invariant(actor?.role==='ops','FORBIDDEN','Operations access required.',403);
      const originStopId=url.searchParams.get('originStopId'),destinationStopId=url.searchParams.get('destinationStopId');
      const fareType=url.searchParams.get('fareType')??'passenger';
      const operatorId=actor.operator_id??url.searchParams.get('operatorId');
      invariant(operatorId,'INVALID_INPUT','Operator is required.',409);
      return fares.recommend({originStopId,destinationStopId,fareType,ownOperatorId:operatorId});
    }
    if(method==='POST' && path==='/ops/fare-observations') {
      invariant(actor?.role==='ops','FORBIDDEN','Operations access required.',403);
      const input=await body();
      invariant(input && Object.keys(input).every(k=>['originStopId','destinationStopId','fareType','priceMinor','sourceReference','sourceUrl','observedAt'].includes(k)),
        'INVALID_OBSERVATION','Unexpected observation fields.');
      invariant(typeof input.sourceUrl==='string' && /^https:\/\/[^\s]+$/i.test(input.sourceUrl) && input.sourceUrl.length<=2000,
        'INVALID_OBSERVATION','A public https source URL is required.');
      return db.transaction(tx=>fares.recordExternal(tx,{...input,sourceReference:input.sourceUrl,sourceType:'external_public'}));
    }
    if(method==='GET' && path==='/ops/plan') return commerce.plan(actor,url.searchParams.get('operatorId'));
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
    // ---- privacy, consent, data rights --------------------------------------
    if(method==='GET' && path==='/me/privacy') return privacy.summary(actor);
    if(method==='GET' && path==='/me/consents') return privacy.consents(actor);
    if(method==='POST' && path==='/me/consents') { await limited('privacy-consent:'+actor.id); return privacy.acceptConsent(actor,await body()); }
    const consentPath=path.match(/^\/me\/consents\/([a-z_]+)$/);
    if(method==='DELETE' && consentPath) { await limited('privacy-consent:'+actor.id); return privacy.withdrawConsent(actor,consentPath[1]); }
    if(method==='POST' && path==='/me/policy-acknowledgements') return privacy.acknowledge(actor,await body());
    if(method==='POST' && path==='/me/data-export') { await limited('privacy-export:'+actor.id); return privacy.requestExport(actor); }
    const exportPath=path.match(/^\/me\/data-export\/([A-Za-z0-9_-]{20,100})$/);
    if(method==='GET' && exportPath) return privacy.downloadExport(actor,exportPath[1]);
    if(method==='GET' && path==='/me/deletion-request') return privacy.deletionStatus(actor);
    if(method==='POST' && path==='/me/deletion-request') { await limited('privacy-deletion:'+actor.id); return privacy.requestDeletion(actor); }
    if(method==='POST' && path==='/me/retention-confirmation') { await limited('privacy-keep:'+actor.id); return privacy.keepAccount(actor); }
    if(method==='POST' && path==='/me/privacy/corrections') return privacy.requestCorrection(actor,await body());
    // Platform Ops only: holds and the privacy request register. Company Ops
    // never see user privacy data outside their own operator scope.
    if(method==='POST' && path==='/ops/privacy/holds') return privacy.createHold(actor,await body());
    const holdPath=path.match(/^\/ops\/privacy\/holds\/([^/]+)\/release$/);
    if(method==='POST' && holdPath) return privacy.releaseHold(actor,holdPath[1]);
    if(method==='GET' && path==='/ops/privacy/requests') {
      invariant(actor?.role==='ops' && !actor.operator_id,'FORBIDDEN','Platform Operations access required.',403);
      return db.transaction(async tx=>({
        deletionRequests: await (await tx.query(`SELECT d.status,d.requested_at,d.processed_at,count(*) OVER() AS total
          FROM deletion_requests d ORDER BY d.requested_at DESC LIMIT 50`)).rows,
        holds: (await tx.query(`SELECT subject_kind,subject_id,reason,created_at,expires_at,released_at FROM legal_holds
          WHERE released_at IS NULL ORDER BY created_at DESC LIMIT 50`)).rows,
        exports: (await tx.query(`SELECT count(*)::integer AS ready FROM data_exports WHERE status='ready' AND expires_at>now()`)).rows[0],
        retention: await retention.run({execute:false}),
      }));
    }
    if(method==='GET' && path==='/ops/provisioning') return provision.catalog(actor);
    const provisionPath=path.match(/^\/ops\/(operators|drivers|convoyeurs|ops-users|places|stops|vehicles|routes|services)$/);
    if(method==='POST' && provisionPath) {
      const operations={operators:'operator',drivers:'driver',convoyeurs:'convoyeur','ops-users':'opsUser',places:'place',stops:'stop',vehicles:'vehicle',routes:'route',services:'service'};
      return provision[operations[provisionPath[1]]](actor,await body(),req.headers.get('idempotency-key'));
    }
    const activation=path.match(/^\/ops\/users\/([^/]+)\/status$/);
    if(method==='PATCH' && activation) return provision.userStatus(actor,uuid(activation[1]),await body(),req.headers.get('idempotency-key'));
    if(method==='POST' && path==='/bookings') {
      invariant(!actor.needs_profile,'PROFILE_REQUIRED','Complete your passenger profile before booking.',409);
      return domain.hold(actor,await body(),req.headers.get('idempotency-key'));
    }
    if(method==='GET' && path==='/me/bookings') return domain.passengerBookings(actor);
    // In-app notification centre. Role-aware by construction: a user only ever
    // reads notifications addressed to their own identity.
    if(method==='GET' && path==='/notifications')
      return notify.list(actor,{unreadOnly:url.searchParams.get('unread')==='true',limit:Number(url.searchParams.get('limit'))||50});
    if(method==='GET' && path==='/notifications/preferences') return notify.preferences(actor);
    if(method==='PUT' && path==='/notifications/preferences') return notify.setPreference(actor,await body());
    const notificationRead=path.match(/^\/notifications\/([^/]+)\/read$/);
    if(method==='POST' && notificationRead) return notify.markRead(actor,notificationRead[1]);
    // First/last mile. Providers are suggestions: LeRoutier books no ride and
    // quotes no fare until a real integration exists.
    if(method==='GET' && path==='/mobility/providers')
      return rides.providers(actor,{country:url.searchParams.get('country')||'BJ',leg:url.searchParams.get('leg')||'first_mile'});
    if(method==='POST' && path==='/mobility/handoff') return rides.recordHandoff(actor,await body());
    // Journey timeline: derived from real booking/service/boarding-point state.
    // localTravelMinutes is an optional client-side estimate and is never stored.
    // Live vehicle tracking for the passenger's own journey: road geometry,
    // latest position, progress, next stop and an arrival estimate aimed at
    // their alighting stop rather than the end of the line.
    const journeyTracking=path.match(/^\/journeys\/([^/]+)\/tracking$/);
    if(method==='GET' && journeyTracking) return track.forBooking(actor,journeyTracking[1]);
    const timeline=path.match(/^\/journeys\/([^/]+)\/timeline$/);
    if(method==='GET' && timeline) {
      const travel=url.searchParams.get('localTravelMinutes');
      return journey.timeline(actor,timeline[1],{localTravelMinutes:travel===null||travel===''?null:Number(travel)});
    }
    const booking=path.match(/^\/bookings\/([^/]+)(?:\/(confirm|cancel|board|alight|payments))?$/);
    if(booking) {
      const id=uuid(booking[1]),action=booking[2];
      if(method==='GET' && !action) return domain.booking(actor,id);
      if(method==='POST' && action==='payments') return domain.recordPayment(actor,id,await body(),req.headers.get('idempotency-key'));
      if(method==='POST' && action) return domain.transition(actor,id,action,['board','alight'].includes(action)?(await body()).stopSequence:undefined);
    }
    if(method==='GET' && path==='/driver/service') {
      invariant(actor.role==='driver' || actor.role==='convoyeur','FORBIDDEN','Crew access required.',403);
      const rows=await list(`SELECT s.*,r.name AS route_name,v.registration,
        bdp.name AS departure_point_name,bdp.description AS departure_point_landmark,
        bap.name AS arrival_point_name,bap.description AS arrival_point_landmark
        FROM service_assignments a JOIN services s ON s.id=a.service_id
        JOIN routes r ON r.id=s.route_id JOIN vehicles v ON v.id=a.vehicle_id
        LEFT JOIN boarding_points bdp ON bdp.id=s.departure_point_id LEFT JOIN boarding_points bap ON bap.id=s.arrival_point_id
        WHERE ((a.driver_id=$1 AND $2='driver') OR (a.convoyeur_id=$1 AND $2='convoyeur')) AND a.ended_at IS NULL
        AND s.status IN ('scheduled','active','disrupted') ORDER BY departure_at LIMIT 1`,[actor.id,actor.role]);
      if(!rows[0]) return null;
      const stops=await list(`SELECT ss.sequence,ss.stop_id,s.name,p.name AS city FROM service_stops ss JOIN stops s ON s.id=ss.stop_id
        JOIN places p ON p.id=s.place_id WHERE ss.service_id=$1 ORDER BY sequence`,[rows[0].id]);
      return {...rows[0],stops};
    }
    const service=path.match(/^\/services\/([^/]+)\/(manifest|advance|positions|status|recovery|schedule|tracking)$/);
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
        const input=validateVehiclePosition(await body());
        return db.transaction(async tx=>{
          const service=await domain.authorizeService(tx,actor,id);
          // A vehicle only reports while it is actually running a service.
          invariant(['scheduled','active','disrupted'].includes(service.status),
            'SERVICE_CLOSED','This service is no longer tracking its vehicle.',409);
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['gps:'+id]);
          invariant(Date.now()-Date.parse(input.observedAt)<=300_000 && Date.parse(input.observedAt)<=Date.now()+10_000,
            'INVALID_POSITION_TIME','Position time is outside the accepted window.');
          invariant(input.accuracyM===null || input.accuracyM<=200,'GPS_ACCURACY','Position is too imprecise.',422);
          const previous=(await tx.query('SELECT observed_at,latitude,longitude,accuracy_m FROM vehicle_positions WHERE service_id=$1 ORDER BY observed_at DESC LIMIT 1',[id])).rows[0];
          invariant(!previous || new Date(input.observedAt)>new Date(previous.observed_at),'STALE_POSITION','A newer position is already stored.',409);
          if(previous) {
            const elapsed=(Date.parse(input.observedAt)-new Date(previous.observed_at).getTime())/1000;
            invariant(elapsed>=5,'GPS_RATE_LIMITED','Wait before sending another position.',429);
            const distance=distanceMetres(input,{latitude:Number(previous.latitude),longitude:Number(previous.longitude)});
            const uncertainty=(input.accuracyM??0)+Number(previous.accuracy_m??0);
            invariant(distance-uncertainty<=elapsed*55,'GPS_JUMP','Position movement is implausible.',422);
          }
          const assignment=(await tx.query('SELECT vehicle_id FROM service_assignments WHERE service_id=$1 AND ended_at IS NULL',[id])).rows[0];
          // Without an active assignment there is no vehicle to attribute the
          // position to; this previously threw and returned a 500.
          invariant(assignment?.vehicle_id,'NO_ASSIGNMENT','No vehicle is assigned to this service.',409);
          const result=await tx.query(`INSERT INTO vehicle_positions(service_id,vehicle_id,actor_id,latitude,longitude,observed_at,accuracy_m,speed_mps,heading_deg,source)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING latitude,longitude,observed_at`,
          [id,assignment.vehicle_id,actor.id,input.latitude,input.longitude,input.observedAt,
            input.accuracyM,input.speedMps,input.headingDeg,input.source]);
          await tx.query('INSERT INTO outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3)',['service.position',id,JSON.stringify({serviceId:id,observedAt:input.observedAt})]);
          return result.rows[0];
        });
      }
      // Route geometry, live position, progress, next stop and arrival estimate
      // for crew and operations. Passengers use /journeys/:bookingId/tracking,
      // which is scoped to their own booking and their own alighting stop.
      if(method==='GET' && action==='tracking') return track.forService(actor,id,domain.authorizeService);
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
          await enqueue(tx,'service.status',id,{status:input.status});
          await audit(tx,actor.id,'service.status_changed',id,s.operator_id,{from:s.status,to:input.status});
          return result;
        });
      }
      // Delay or boarding-point correction. Passengers are re-notified and
      // their first-mile advice is recomputed from the new departure time.
      if(method==='POST' && action==='schedule') return domain.reschedule(actor,id,await body());
      if(method==='POST' && action==='recovery') return recover.assign(actor,{...await body(),serviceId:id});
    }
    // Operational diagnostics: machine-readable counts for the Ops console.
    // Counts only — no party data, no secrets, no mutation. Ops-auth required.
    // Live fleet for operations, scoped to the caller's own operator.
    if(method==='GET' && path==='/ops/fleet-tracking') return track.fleet(actor);
    // Road geometry for a route: read it, or ask the engine to (re)generate it.
    const routeGeom=path.match(/^\/routes\/([^/]+)\/geometry$/);
    if(routeGeom) {
      if(method==='GET') return geometry.read(routeGeom[1]);
      if(method==='POST') return geometry.generate(actor,routeGeom[1],{force:(await body()).force===true});
    }
    // Model provider status. Two endpoints on purpose: usage is free to poll,
    // health costs a real (tiny) call and is therefore explicit.
    if(method==='GET' && path==='/ops/model-usage') {
      invariant(actor.role==='ops' && !actor.operator_id,'FORBIDDEN','Platform Operations access required.',403);
      return reasoning.usage();
    }
    if(method==='GET' && path==='/ops/health') { const h=await health.read(actor); return { ...h, channels: channelAvailability(config) }; }
    if(method==='POST' && path==='/ops/model-health') {
      // Platform Ops only: it spends quota, so an operator admin cannot drain
      // the shared budget by refreshing a dashboard.
      invariant(actor.role==='ops' && !actor.operator_id,'FORBIDDEN','Platform operations access required.',403);
      await limited('model-health:'+actor.id);
      // Never the key, never the Authorization header, never the raw response.
      return reasoning.health();
    }
    if(method==='GET' && path==='/ops/diagnostics') {
      invariant(actor.role==='ops','FORBIDDEN','Operations access required.',403);
      return db.transaction(async tx=>{
        const scope=actor.operator_id;
        const rows=(await tx.query(`SELECT
          (SELECT count(*) FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN services s ON s.id=b.service_id
            WHERE p.status='failed' AND ($1::uuid IS NULL OR s.operator_id=$1))::integer AS failed_payments,
          (SELECT count(*) FROM payout_requests r JOIN driver_profiles dp ON dp.user_id=r.driver_id
            WHERE r.status='failed' AND ($1::uuid IS NULL OR dp.operator_id=$1))::integer AS failed_payouts,
          (SELECT count(*) FROM payout_requests r JOIN driver_profiles dp ON dp.user_id=r.driver_id
            WHERE r.status='processing' AND ($1::uuid IS NULL OR dp.operator_id=$1))::integer AS processing_payouts,
          (SELECT count(*) FROM incidents i JOIN services s ON s.id=i.service_id
            WHERE i.status<>'resolved' AND ($1::uuid IS NULL OR s.operator_id=$1))::integer AS open_incidents,
          (SELECT count(*) FROM services s JOIN service_assignments a ON a.service_id=s.id AND a.ended_at IS NULL
            WHERE s.status IN ('active','disrupted') AND ($1::uuid IS NULL OR s.operator_id=$1)
            AND NOT EXISTS(SELECT 1 FROM vehicle_positions vp WHERE vp.service_id=s.id AND vp.observed_at>now()-interval '30 minutes'))::integer AS stale_tracking,
          (SELECT count(*) FROM outbox WHERE $1::uuid IS NULL AND event_type IN ('payment.anomaly','payout.anomaly') AND created_at>now()-interval '7 days')::integer AS payment_anomalies,
          (SELECT count(*) FROM workflow_runs WHERE status='failed' AND ($1::uuid IS NULL OR operator_id=$1))::integer AS failed_workflows,
          (SELECT count(*) FROM workflow_runs WHERE status='awaiting_approval' AND ($1::uuid IS NULL OR operator_id=$1))::integer AS awaiting_approvals,
          (SELECT count(*) FROM parcel_exceptions e JOIN parcels p ON p.id=e.parcel_id
            WHERE e.status='open' AND ($1::uuid IS NULL OR p.operator_id=$1))::integer AS open_parcel_exceptions,
          (SELECT count(*) FROM parcels p WHERE p.status='ready_for_pickup' AND p.updated_at<now()-interval '24 hours'
            AND ($1::uuid IS NULL OR p.operator_id=$1))::integer AS uncollected_parcels,
          (SELECT count(*) FROM parcels p WHERE p.status='ready_for_pickup' AND ($1::uuid IS NULL OR p.operator_id=$1))::integer AS ready_parcels`,[scope])).rows;
        const d=rows[0];
        const failedRuns=(await tx.query(`SELECT id,workflow,step,attempts,created_at,context->'failure'->>'code' AS failure_code
          FROM workflow_runs WHERE status='failed' AND ($1::uuid IS NULL OR operator_id=$1) ORDER BY updated_at DESC LIMIT 10`,[scope])).rows;
        return {
          generatedAt:new Date().toISOString(),database:'ok',
          fedapay:{collections:pay.configured,payouts:!!(adapter && adapter.payoutsAvailable),environment:adapter?.environment ?? null},
          payments:{failed:d.failed_payments,anomalies7d:d.payment_anomalies},
          payouts:{failed:d.failed_payouts,processing:d.processing_payouts},
          incidents:{open:d.open_incidents},
          services:{staleTracking:d.stale_tracking},
          workflows:{failed:d.failed_workflows,awaitingApproval:d.awaiting_approvals,failedRuns},
          parcels:{openExceptions:d.open_parcel_exceptions,uncollected:d.uncollected_parcels,readyForPickup:d.ready_parcels},
        };
      });
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
        await enqueue(tx,'incident.updated',row.id,{status:input.status});
        await audit(tx,actor.id,'incident.status_changed',row.id,null,{serviceId:row.service_id,from:row.status,to:input.status});
        return result;
      });
    }
    throw new DomainError('NOT_FOUND','Endpoint not found.',404);
  }
  return async req=>{
    const incomingId=req.headers.get('x-request-id');
    const requestId=/^[a-f0-9-]{36}$/i.test(incomingId??'') ? incomingId : randomUUID();
    const origin=req.headers.get('origin');
    const allowed=!origin || config.corsOrigins.includes(origin);
    // A JSON API is never a document: it is never framed, never referred from,
    // and never sniffed into another content type. Transport security (HSTS) is
    // added by the platform edge, so it is not duplicated here.
    const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','vary':'Origin','x-request-id':requestId,
      'x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; frame-ancestors 'none'"};
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
      if(req.method==='OPTIONS') return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':'GET,POST,PUT,PATCH,OPTIONS','access-control-allow-headers':'Authorization,Content-Type,Idempotency-Key,X-Request-ID'}});
      const data=await route(req,path,url,req.method,body(req));
      if(legacy){headers.deprecation='true';headers.sunset='2026-12-31T23:59:59Z';}
      // One route answers a telecom gateway in plain text; everything else
      // uses the JSON envelope. Both get the same security headers.
      if(data instanceof RawResponse) return new Response(data.body,{headers:{...headers,'content-type':data.contentType}});
      return new Response(JSON.stringify({data}),{headers});
    } catch(error) {
      const known=error instanceof DomainError;
      const conflict=['23505','23514','23503'].includes(error.code);
      const status=known?error.status:conflict?409:503;
      if(legacy && status!==404){headers.deprecation='true';headers.sunset='2026-12-31T23:59:59Z';}
      // Operational visibility: unexpected errors are logged with code and
      // message only (no connection strings, no credentials, no payloads).
      if(!known && !conflict) console.error(JSON.stringify({event:'api.error',requestId,status,
        code:/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:'INTERNAL_ERROR'}));
      if(status>=500) await health.record('api_error');
      else if(path==='/webhooks/fedapay') await health.record('webhook_rejected');
      else if(['GPS_JUMP','GPS_ACCURACY','INVALID_POSITION_TIME'].includes(error.code)) await health.record('gps_anomaly');
      return new Response(JSON.stringify({error:{code:known?error.code:conflict?'CONFLICT':'INTERNAL_ERROR',message:known?error.message:conflict?'The operation conflicts with current data.':'The service is temporarily unavailable.',requestId}}),{status,headers});
    }
  };
}
