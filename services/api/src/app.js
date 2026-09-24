import { randomUUID } from 'node:crypto';
import { DomainError, invariant, uuid } from '@leroutier/domain';
import { transport } from '@leroutier/database/transport';
import { validateVehiclePosition, distanceMetres } from '@leroutier/geo';
import { enqueue, channelAvailability } from '@leroutier/notifications';
import { authentication } from './auth.js';
import { publicAuthConfig } from '@leroutier/config';
import { updateProfile, audit, managesOperator } from '@leroutier/database/identities';
import { provisioning } from '@leroutier/database/provisioning';
import { requirePlatform, requireAnyPlatform } from '@leroutier/database/platform-access';
import { schemaStatus } from '@leroutier/database/migrations';
import { payments } from '@leroutier/database/payments';
import { tickets } from '@leroutier/database/tickets';
import { ratings } from '@leroutier/database/ratings';
import { insurance, insuranceAdmin } from '@leroutier/database/insurance';
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
import { notificationProviders, brevoTransactionalSender } from '@leroutier/database/notification-providers';
import { verificationEmail } from '@leroutier/notifications/content';
import { createFirebaseAdmin } from '@leroutier/firebase-admin';
import { operationalHealth } from '@leroutier/database/operational-health';
import { fareIntelligence } from '@leroutier/database/fare-intelligence';
import { commercial } from '@leroutier/database/commercial';
import { assistantService } from './assistant.js';
import { privacyCenter, retentionEngine } from '@leroutier/database/privacy';
import { evidenceStore, MAX_EVIDENCE_BYTES } from '@leroutier/database/evidence-storage';
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

/**
 * A response this handler renders itself rather than wrapping in the JSON
 * envelope: the USSD gateway's plain text, and readiness, which has to be able
 * to answer 503 with a body a monitor can read.
 */
class RawResponse {
  constructor(body, contentType, status = 200) { this.body = body; this.contentType = contentType; this.status = status; }
}

export function createApi(db, config, keyResolver=undefined, adapter=paymentAdapter(config), fetcher=fetch) {
  // The raw server configuration, captured BEFORE notificationProviders are
  // replaced by live adapters below: the Brevo SETTINGS (key, sender) live
  // there, and the standalone verification sender needs them.
  const settings=config;
  const providers=notificationProviders(db,config,fetcher);
  config={...config,notificationProviders:providers};
  // Server-only Firebase identity administration. Tests inject their own
  // through config.firebaseAdmin; production resolves the service-account
  // credential (or stays unavailable, which callers fail closed on).
  const firebaseAdmin=config.firebaseAdmin ?? createFirebaseAdmin(config);
  // Standalone Brevo sender for the account-verification email. Its recipient
  // is an unverified Firebase identity — no users.id, no notification row —
  // so it cannot travel the notification pipeline; it uses the SAME provider,
  // settings and failure vocabulary instead of inventing a second system.
  const verificationMail=brevoTransactionalSender(settings.notificationProviders?.brevo ?? {}, fetcher);
  // Private storage for KYC/KYB documents. Null when no provider is
  // configured, which is a supported state: the product keeps accepting
  // operator-hosted links and keeps saying plainly that it does not hold the
  // documents. Constructed once and passed in, so no vendor call appears
  // anywhere outside evidence-storage.js.
  const evidence=config.evidenceStore ?? evidenceStore(config);
  const health=operationalHealth(db);
  const fares=fareIntelligence(db);
  const commerce=commercial(db);
  const domain=transport(db), auth=authentication(db,config,keyResolver),provision=provisioning(db,config);
  const pay=payments(db,adapter),ticket=tickets(db),rating=ratings(db);
  const cover=insurance(db),coverAdmin=insuranceAdmin(db);
  const earn=earnings(db),payout=payouts(db,adapter,config),recover=recovery(db),parcel=parcels(db);
  const onboard=onboarding(db,evidence),loc=locations(db),settle=operatorSettlements(db,adapter),walkUp=walkUpBookings(db);
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
  const privacy=privacyCenter(db,evidence);
  const retention=retentionEngine(db,evidence);
  const planner=journeyPlanning(db,{boardingBufferS:config.journey?.boardingBufferS ?? 600});
  const assistant=assistantService({db,domain,parcels:parcel,fares,health,track,privacy});
  const list=(query,params=[])=>db.transaction(async tx=>(await tx.query(query,params)).rows);
  async function limited(subject, ceiling=120) {
    await db.transaction(async tx=>{
      const {rows}=await tx.query(`INSERT INTO request_limits(subject,window_at,requests) VALUES($1,date_trunc('minute',now()),1)
        ON CONFLICT(subject,window_at) DO UPDATE SET requests=request_limits.requests+1 RETURNING requests`,[subject]);
      invariant(rows[0].requests<=ceiling,'RATE_LIMITED','Too many requests. Try again shortly.',429);
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
      '/webhooks/fedapay': ['POST'], '/auth/demo': ['POST'], '/auth/email-verification': ['POST'], '/me': ['GET', 'PATCH'],
      '/me/bookings': ['GET'], '/me/parcels': ['GET'], '/notifications': ['GET'],
      '/notifications/preferences': ['GET', 'PUT'], '/parcels/quote': ['GET'], '/parcels': ['POST'],
      '/bookings': ['POST'], '/operator/settlements': ['GET'], '/operator/payouts': ['GET', 'POST'],
      '/driver/earnings': ['GET'], '/driver/parcels': ['GET'], '/driver/parcels/lookup': ['GET'], '/driver/service': ['GET'],
      '/driver/payouts': ['GET', 'POST'], '/driver/payout-destinations': ['GET', 'POST'],
      '/driver/walk-up-bookings': ['POST'], '/driver/actions': ['POST'],
      '/onboarding/me': ['GET'], '/onboarding/company': ['POST'], '/onboarding/independent': ['POST'],
      '/onboarding/operator': ['PATCH'], '/onboarding/evidence': ['GET'], '/ops/corridors': ['GET'],
      '/ops/evidence-storage': ['GET'],
      '/ops/platform-team': ['GET', 'POST'], '/ops/platform-capabilities': ['GET'],
      '/insurance/offers': ['GET'], '/ops/insurance/partners': ['GET', 'POST'],
      '/ops/insurance/products': ['POST'], '/ops/insurance/policies': ['GET'],
      '/health/ready': ['GET'],
      '/operators': ['GET'], '/incidents': ['GET', 'POST'],
      '/boarding-points': ['GET'], '/boarding-points/proposals': ['POST'], '/mobility/providers': ['GET'],
      '/mobility/handoff': ['POST'], '/tickets/verify': ['POST'], '/workflows': ['GET'],
      '/workflows/tick': ['POST'], '/assistant': ['POST'],
    };
    if (METHOD_ALLOW[path] && !METHOD_ALLOW[path].includes(method)) {
      throw new DomainError('METHOD_NOT_ALLOWED', 'Method not allowed for this endpoint.', 405);
    }
    if(method==='GET' && path==='/health') {await list('SELECT 1');return {status:'ok'};}
    // Readiness, as distinct from liveness.
    //
    // /health stays exactly what it was so infrastructure health checks keep
    // working: a process that answers and a database it can reach. That pair
    // is precisely what stayed green for the whole of the 2026-09-22 outage,
    // while every authenticated request returned 503 because the deployed code
    // queried a column fourteen migrations in the future.
    //
    // So readiness asks the question liveness cannot: does the database this
    // build is talking to have the schema this build expects. Unauthenticated,
    // because a deployment gate has no credentials — and therefore counts and
    // a state word only. Migration FILENAMES describe unreleased work and are
    // reserved for Platform Ops holding `system`; no SQL, no host, no
    // credential appears here under any state.
    if(method==='GET' && path==='/health/ready') {
      const schema=await schemaStatus(db);
      const ready=schema.status==='current'||schema.status==='ahead';
      return new RawResponse(JSON.stringify({data:{
        service:'healthy',
        database:schema.reachable?'reachable':'unreachable',
        schema:schema.status,
        ready,
        migrations:schema.counts,
        // Which build is answering, so a post-deploy check can tell the new
        // deployment from the one it replaced instead of asserting against
        // whatever happens to be serving.
        commit:config.commitSha??null,
      }}),'application/json; charset=utf-8',ready?200:503);
    }
    if(method==='GET' && path==='/auth/config') return publicAuthConfig(config);
    // `payouts.available` used to mean "a secret key is set", which is not
    // something a driver can act on: they saw a withdrawal button, requested
    // one, had their balance reserved, and the transfer failed at a provider
    // that had never activated Payouts for this account. The state now says
    // what is actually proven, and `available` stays a boolean so existing
    // callers keep working — it is simply true only when it is true.
    if(method==='GET' && path==='/payments/config') {
      const payoutCapability=await payout.capability();
      return {available:pay.configured,
        payouts:{available:payoutCapability.state==='available',...payoutCapability}};
    }
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
    if(method==='POST' && path==='/auth/demo') {invariant(config.demoLogin,'NOT_FOUND','Endpoint not found.',404);await limited('demo-login');const input=await body();return auth.demoSession(input.role,input.profile);}
    // Account verification email. A newly created Firebase identity is NOT a
    // LeRoutier user yet — /me refuses it — so this path deliberately bypasses
    // the /me mapper and the notification tables (which need users.id). The
    // address always comes from the VERIFIED TOKEN's claims, never from a body
    // field, and the generated action link never reaches the response.
    if(method==='POST' && path==='/auth/email-verification') {
      const token=req.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
      invariant(token && token.length<8192,'UNAUTHORIZED','Sign in to continue.',401);
      const claims=await auth.verifyToken(token);
      const ip=(req.headers.get('x-forwarded-for')||'').split(',')[0].trim()||'local';
      await limited('verify-email-ip:'+ip);
      await limited('verify-email:'+claims.subject,5);
      // Only password identities use this flow; Google verifies its own.
      invariant(claims.signInProvider==='password','FORBIDDEN','Cette action est réservée aux comptes créés avec une adresse e-mail et un mot de passe.',403);
      if(claims.emailVerified===true) return {status:'already_verified'};
      invariant(claims.email,'UNAUTHORIZED','Session is invalid or expired.',401);
      let link;
      try { link=await firebaseAdmin.generateEmailVerificationLink(claims.email,config.appUrl+'/verify-email'); }
      catch { throw new DomainError('VERIFICATION_UNAVAILABLE','Impossible d’envoyer l’e-mail de confirmation pour le moment. Réessayez plus tard.',503); }
      // The send result is a reason, never a provider message: the raw action
      // link must not surface anywhere, response included.
      const send=await verificationMail.send({to:claims.email,...verificationEmail(link)});
      invariant(send.accepted===true,'VERIFICATION_UNAVAILABLE','Impossible d’envoyer l’e-mail de confirmation pour le moment. Réessayez plus tard.',503);
      return {status:'sent'};
    }
    // The public catalogue is the one authenticated-free read surface with real
    // breadth: every stop, every place, every route, every departure. Without a
    // limit it is a free scraping and enumeration endpoint, so anonymous reads
    // are metered per client address exactly as public parcel tracking is.
    // Authenticated traffic is metered per identity further down.
    const meterAnonymous=()=>limited('public-catalogue:'+((req.headers.get('x-forwarded-for')||'').split(',')[0].trim()||'local'));
    if(method==='GET' && ['/stops','/places','/routes','/services'].includes(path)) await meterAnonymous();
    const testInventoryVisible = async () => {
      if (url.searchParams.get('testMode') !== '1') return false;
      const tester = await auth.authenticate(req).catch(() => null);
      return (config.allowTestInventory === true && !config.production) || tester?.is_demo === true;
    };
    // Door-to-destination journey planning over the existing service domain.
    // The passenger's exact current coordinates are transient: used only to
    // resolve the first mile, never stored and never exposed to operators.
    // Origins/destinations may be stops, canonical geography places, or raw
    // coordinates: a place that is not served still resolves to a first/last
    // mile around the nearest practical stop.
    if(method==='GET' && path==='/journey-plan') {
      const q = url.searchParams;
      const origin = q.has('lat') && q.has('lon') ? { latitude: Number(q.get('lat')), longitude: Number(q.get('lon')) } : null;
      const originPlaceId = q.get('originPlaceId');
      const destinationPlaceId = q.get('destinationPlaceId');
      const resolvePlace = async id => id ? (await list(`SELECT id,name,kind,latitude,longitude FROM places WHERE id=$1 AND latitude IS NOT NULL LIMIT 1`, [uuid(id)]))[0] : null;
      const originPlace = originPlaceId ? await resolvePlace(originPlaceId) : null;
      const destinationPlace = destinationPlaceId ? await resolvePlace(destinationPlaceId) : null;
      // A place id that does not resolve is a bad request, not a silent
      // "no origin/destination" — the caller must know the id was wrong.
      invariant(!originPlaceId || originPlace, 'INVALID_JOURNEY', 'Origin place is unknown.', 404);
      invariant(!destinationPlaceId || destinationPlace, 'INVALID_JOURNEY', 'Destination place is unknown.', 404);
      // Test mode: the synthetic TEST inventory is opt-in and authorized. A
      // query parameter alone never exposes it — the session must also be a
      // designated test identity, or the deployment must allow test
      // inventory explicitly (local, CI, preview).
      const includeDemo = await testInventoryVisible();
      return planner.plan({
        originStopId: originPlace ? null : q.get('originStopId'), origin: origin ?? (originPlace ? { latitude: Number(originPlace.latitude), longitude: Number(originPlace.longitude) } : null),
        destinationStopId: destinationPlace ? null : q.get('destinationStopId'),
        destination: q.has('destLat') && q.has('destLon') ? { latitude: Number(q.get('destLat')), longitude: Number(q.get('destLon')) } : (destinationPlace ? { latitude: Number(destinationPlace.latitude), longitude: Number(destinationPlace.longitude) } : null),
        departureAt: q.get('departureAt'),
        includeDemo,
      });
    }
    if(method==='GET' && path==='/stops') {
      const search=(url.searchParams.get('q') || '').slice(0,100);
      return list(`SELECT s.*,p.name AS city FROM stops s JOIN places p ON p.id=s.place_id
        WHERE (s.name ILIKE $1 OR p.name ILIKE $1) AND (NOT s.is_demo OR $2)
        ORDER BY p.name,s.name LIMIT 100`,['%'+search+'%', await testInventoryVisible()]);
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
      // normalized_name and aliases ride along so the client can fold accents
      // and match spelling variants over the full commune list offline.
      if(q) return list(`SELECT id,name,kind,parent_id,latitude,longitude,normalized_name,aliases FROM places
        WHERE (name ILIKE $1 OR normalized_name ILIKE $2 OR aliases::text ILIKE $2) AND ${kindFilter}
        ORDER BY (kind='city') DESC, name LIMIT 100`,[`%${q}%`,`%${q.toLowerCase()}%`]);
      return list(`SELECT id,name,kind,parent_id,latitude,longitude,normalized_name,aliases FROM places
        WHERE ${kindFilter} ORDER BY name LIMIT 200`);
    }
    // The insurance catalogue. Public, like the fare and the seat map: the
    // add-on has to be visible while somebody is still deciding, not revealed
    // after they have paid. It carries no personal data — product names,
    // cover amounts and a partner's trading name — so there is nothing here to
    // protect, only a rate limit to stop it being scraped in a loop.
    if(method==='GET' && path==='/insurance/offers') {
      await meterAnonymous();
      const declared=url.searchParams.get('declaredValueMinor');
      return cover.offers({scope:url.searchParams.get('scope'),
        ...(declared?{declaredValueMinor:Number(declared)}:{})});
    }
    if(method==='GET' && path==='/routes') return list(`SELECT r.*,coalesce((SELECT json_agg(json_build_object('sequence',rs.sequence,'stopId',s.id,'name',s.name,'city',p.name) ORDER BY rs.sequence)
      FROM route_stops rs JOIN stops s ON s.id=rs.stop_id JOIN places p ON p.id=s.place_id
      WHERE rs.route_id=r.id AND (NOT s.is_demo OR $1)),'[]') AS stops
      FROM routes r WHERE active=true AND (NOT r.is_demo OR $1) ORDER BY name`, [await testInventoryVisible()]);
    // The same search the USSD channel runs. One query, one answer to
    // "is there a seat?", whichever client is asking.
    if(method==='GET' && path==='/services') {
      const includeDemo = await testInventoryVisible();
      return domain.search({originStopId:url.searchParams.get('originStopId'),destinationStopId:url.searchParams.get('destinationStopId'),includeDemo});
    }
    // The seat map for one span. Public: choosing a seat is part of comparing
    // an offer, and asking somebody to sign in to see whether a window seat is
    // free would be the auth-timing regression this product keeps avoiding.
    const seatPlan=path.match(/^\/services\/([^/]+)\/seats$/);
    if(method==='GET' && seatPlan) {
      const serviceId=uuid(seatPlan[1]);
      await meterAnonymous();
      const testService=(await list('SELECT is_demo FROM services WHERE id=$1',[serviceId]))[0];
      if(testService?.is_demo) {
        const tester=await auth.authenticate(req).catch(()=>null);
        invariant(url.searchParams.get('testMode')==='1' && ((config.allowTestInventory===true && !config.production) || tester?.is_demo===true),'NOT_FOUND','Service not found.',404);
      }
      return domain.seats(serviceId,url.searchParams.get('origin'),url.searchParams.get('destination'));
    }
    const available=path.match(/^\/services\/([^/]+)\/availability$/);
    // Metered after validation: rejecting a malformed identifier must stay free,
    // or the limiter becomes its own amplifier — one bad request, one DB write.
    if(method==='GET' && available) {
      const serviceId=uuid(available[1]);
      await meterAnonymous();
      const testService = (await list('SELECT is_demo FROM services WHERE id=$1', [serviceId]))[0];
      if (testService?.is_demo) {
        const tester = await auth.authenticate(req).catch(()=>null);
        invariant(url.searchParams.get('testMode') === '1' && ((config.allowTestInventory === true && !config.production) || tester?.is_demo === true), 'NOT_FOUND', 'Service not found.', 404);
      }
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
    //
    // ANY failure here is a failure to identify the caller, not only a
    // DomainError. Testing for DomainError alone let an unexpected error — a
    // driver-level database error, for instance — become the `actor` object
    // itself, which /me then returned with a 200 and the provider's internals
    // (schema, table, constraint, source routine) inside it.
    const human=await auth.authenticate(req).catch(error=>error);
    const unidentified=human instanceof Error;
    const agent=unidentified ? await authenticateAgent(db,req) : null;
    if(unidentified && !agent) throw human;
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
      await notificationDelivery(db,providers,config).tick();
      return result;
    }
    if(method==='POST' && path==='/tickets/verify')return ticket.verify(actor,await body());
    if(method==='POST' && path==='/driver/actions')return driverAction(db,actor,await body(),req.headers.get('idempotency-key'));
    // --- Onboarding & membership (one canonical operator model) ---
    if(method==='GET' && path==='/onboarding/me') return onboard.state(actor);
    if(method==='POST' && path==='/onboarding/company') return onboard.startCompany(actor,await body(),req.headers.get('idempotency-key'));
    if(method==='POST' && path==='/onboarding/independent') return onboard.startIndependent(actor,await body(),req.headers.get('idempotency-key'));
    if(method==='PATCH' && path==='/onboarding/operator') return onboard.updateProfile(actor,await body());
    // An operator reading its own verification file, and replacing a proof a
    // reviewer refused. Without these an operator rejected for a blurry carte
    // grise was told nothing and could do nothing: the server demanded a
    // replacement the product had no way to submit.
    if(method==='GET' && path==='/onboarding/evidence') return onboard.dossier(actor);
    const evidenceResubmit=path.match(/^\/onboarding\/evidence\/([^/]+)$/);
    if(method==='POST' && evidenceResubmit) return onboard.resubmitEvidence(actor,evidenceResubmit[1],await body());
    // Uploading the document itself, where LeRoutier holds the bytes. Binary,
    // so it does not go through the JSON envelope reader — and capped before
    // anything is read into memory.
    const evidenceUpload=path.match(/^\/onboarding\/evidence\/([^/]+)\/file$/);
    if(method==='POST' && evidenceUpload) {
      const declared=Number(req.headers.get('content-length')??0);
      invariant(!Number.isFinite(declared)||declared<=MAX_EVIDENCE_BYTES,'INVALID_EVIDENCE_FILE','Le justificatif dépasse la taille maximale de 8 Mo.',413);
      const buffer=new Uint8Array(await req.arrayBuffer());
      invariant(buffer.length<=MAX_EVIDENCE_BYTES,'INVALID_EVIDENCE_FILE','Le justificatif dépasse la taille maximale de 8 Mo.',413);
      return onboard.uploadEvidence(actor,evidenceUpload[1],buffer);
    }
    // A reviewer opening ONE proof, at the moment they open it. The list
    // payloads carry no document address at all, so a permanent URL never sits
    // in a console's memory, a browser log or a copied response.
    const evidenceAccess=path.match(/^\/ops\/evidence\/([^/]+)\/access$/);
    if(method==='GET' && evidenceAccess) return onboard.accessEvidence(actor,evidenceAccess[1]);
    if(method==='GET' && path==='/ops/evidence-storage') {
      requireAnyPlatform(actor,['system','verification']);
      return onboard.storage();
    }
    if(method==='GET' && path==='/operators') return onboard.listOperators(actor);
    // One operator's verification evidence, on demand. The review queue only
    // carries operators awaiting a first decision, so without this a verified
    // operator's dossier could never be re-read — and oversight that cannot
    // re-open a file is not oversight. Platform Ops only; the module checks.
    const operatorEvidence=path.match(/^\/ops\/operators\/([^/]+)\/evidence$/);
    if(method==='GET' && operatorEvidence) return onboard.evidence(actor,uuid(operatorEvidence[1]));
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
    // A GET whose query string is a CREDENTIAL, not a filter: it accepts an LRP
    // reference or a label token. Reads are otherwise unmetered, which left the
    // one guessable secret on a read path with no ceiling at all.
    if(method==='GET' && path==='/driver/parcels/lookup') {
      await limited('parcel-lookup:'+actor.id);
      return parcel.lookupDriver(actor, url.searchParams.get('code'));
    }
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
    // Rating the operator that carried you. Gated on a completed journey by
    // the domain, and keyed by the booking, so one journey rates once.
    const ratingPath=path.match(/^\/bookings\/([^/]+)\/rating$/);
    if(method==='GET' && ratingPath) return rating.forBooking(actor,uuid(ratingPath[1]));
    if(method==='POST' && ratingPath) { await limited('rating:'+actor.id); return rating.rate(actor,uuid(ratingPath[1]),await body()); }
    if(method==='GET' && path==='/ops/ratings') return rating.forOperator(actor,url.searchParams.get('operatorId'));

    // Cover on one trip or one parcel. The scope is in the path rather than
    // the body so a booking route can never be handed a parcel id by a caller
    // who mixed the two up: the handler decides which it is, not the client.
    const coverPath=path.match(/^\/(bookings|parcels)\/([^/]+)\/insurance$/);
    if(coverPath){
      const scope=coverPath[1]==='bookings'?'trip':'parcel', id=uuid(coverPath[2]);
      if(method==='GET') return cover.forSubject(actor,scope,id);
      if(method==='POST'){
        await limited('insurance:'+actor.id);
        return cover.attach(actor,{...await body(),scope,subjectId:id},req.headers.get('idempotency-key'));
      }
    }
    const coverCancel=path.match(/^\/insurance\/policies\/([^/]+)\/cancel$/);
    if(method==='POST' && coverCancel) return cover.cancel(actor,uuid(coverCancel[1]));

    // Platform side. Every one of these asks for the `insurance` capability
    // inside the domain module, not here, so a new caller cannot reach them by
    // adding a route and forgetting the check.
    if(method==='GET' && path==='/ops/insurance/partners') return coverAdmin.partners(actor);
    if(method==='POST' && path==='/ops/insurance/partners')
      return coverAdmin.savePartner(actor,await body(),req.headers.get('idempotency-key'));
    if(method==='POST' && path==='/ops/insurance/products')
      return coverAdmin.saveProduct(actor,await body(),req.headers.get('idempotency-key'));
    if(method==='GET' && path==='/ops/insurance/policies')
      return coverAdmin.queue(actor,{status:url.searchParams.get('status')??'requested',
        partnerId:url.searchParams.get('partnerId')??null});
    const coverDecision=path.match(/^\/ops\/insurance\/policies\/([^/]+)\/(decision|shared)$/);
    if(method==='POST' && coverDecision){
      const id=uuid(coverDecision[1]);
      return coverDecision[2]==='shared'?coverAdmin.markShared(actor,id):coverAdmin.record(actor,id,await body());
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
    // Simulated payment for TEST bookings. The bypass is strictly tied to
    // authorized test inventory: the deployment must allow test inventory or
    // the session must be a designated test identity. No real provider is
    // contacted and no settlement is credited.
    const testPayment=path.match(/^\/bookings\/([^/]+)\/payments\/test$/);
    if(method==='POST' && testPayment) {
      const id=uuid(testPayment[1]);
      invariant((config.allowTestInventory===true && !config.production) || actor?.is_demo===true,
        'FORBIDDEN','Test payment is only available in test mode.',403);
      await limited('test-payment:'+actor.id);
      return domain.simulatedTestPayment(actor,id,req.headers.get('idempotency-key'), { allowTestInventory: config.allowTestInventory === true && !config.production });
    }
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
      requirePlatform(actor,'users');
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
    // Known corridors, so an operator does not have to invent a road thousands
    // of people already travel. A corridor is never a service.
    if(method==='GET' && path==='/ops/corridors') return provision.corridors(actor);
    const provisionPath=path.match(/^\/ops\/(operators|drivers|convoyeurs|ops-users|places|stops|vehicles|routes|services)$/);
    if(method==='POST' && provisionPath) {
      const operations={operators:'operator',drivers:'driver',convoyeurs:'convoyeur','ops-users':'opsUser',places:'place',stops:'stop',vehicles:'vehicle',routes:'route',services:'service'};
      return provision[operations[provisionPath[1]]](actor,await body(),req.headers.get('idempotency-key'));
    }
    // ---- LeRoutier's own staff ----------------------------------------------
    //
    // Separate from /ops/ops-users, which provisions a transport company's
    // operations account inside one operator. These are platform identities:
    // no operator, and only the authorizations they are explicitly granted.
    if(method==='GET' && path==='/ops/platform-team') return provision.platformTeam(actor);
    if(method==='GET' && path==='/ops/platform-capabilities') {
      requirePlatform(actor,'provisioning');
      return {capabilities:provision.catalogCapabilities()};
    }
    if(method==='POST' && path==='/ops/platform-team')
      return provision.platformUser(actor,await body(),req.headers.get('idempotency-key'));
    const platformGrants=path.match(/^\/ops\/platform-team\/([^/]+)\/grants$/);
    if(method==='PUT' && platformGrants)
      return provision.platformGrants(actor,uuid(platformGrants[1]),await body(),req.headers.get('idempotency-key'));
    const activation=path.match(/^\/ops\/users\/([^/]+)\/status$/);
    if(method==='PATCH' && activation) return provision.userStatus(actor,uuid(activation[1]),await body(),req.headers.get('idempotency-key'));
    // Platform Ops account deletion: the SAME retention-aware privacy model as
    // self-service deletion, targeted at another account and audited with the
    // initiator. Never a SQL DELETE, never a cascade — blockers schedule,
    // and the processor (with Firebase identity deletion) completes later.
    const opsDeletion=path.match(/^\/ops\/users\/([^/]+)\/deletion-request$/);
    if(method==='POST' && opsDeletion) { await limited('ops-deletion:'+actor.id); return privacy.requestDeletionFor(actor,uuid(opsDeletion[1])); }
    if(method==='POST' && path==='/bookings') {
      invariant(!actor.needs_profile,'PROFILE_REQUIRED','Complete your passenger profile before booking.',409);
      const booking=await body();
      invariant(booking && Object.keys(booking).every(k=>['serviceId','origin','destination','seatNumber'].includes(k)),
        'INVALID_BOOKING','Unexpected booking fields.');
      return domain.hold(actor,booking,req.headers.get('idempotency-key'));
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
        invariant(actor.role==='driver','FORBIDDEN','Driver access required.',403);
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
          invariant(actor.role==='driver' || actor.role==='ops','FORBIDDEN','Driver or operations access required.',403);
          const s=await domain.authorizeService(tx,actor,id,actor.role==='ops');
          if(actor.role==='driver') {
            invariant(['active','completed'].includes(input.status),'FORBIDDEN','Drivers may start or complete their assigned service.',403);
            if(input.status==='completed') invariant(!(await tx.query('SELECT 1 FROM service_stops WHERE service_id=$1 AND sequence>$2',[id,s.current_sequence])).rowCount,
              'INVALID_STOP','Reach the final stop before completing the service.',409);
          }
          invariant(['active','disrupted','completed','cancelled'].includes(input.status),'INVALID_STATUS','Invalid service status.');
          const allowed={scheduled:['active','cancelled'],active:['disrupted','completed'],disrupted:['active','cancelled'],completed:[],cancelled:[]};
          invariant(allowed[s.status].includes(input.status),'INVALID_TRANSITION','Service transition is invalid.',409);
          if(['completed','cancelled'].includes(input.status)) {
            invariant(!(await tx.query("SELECT id FROM bookings WHERE service_id=$1 AND status IN ('held','confirmed','boarded')",[id])).rowCount,'ACTIVE_BOOKINGS','Resolve active bookings before closing this service.',409);
            invariant(!(await tx.query("SELECT id FROM parcel_service_assignments WHERE service_id=$1 AND status IN ('assigned','loaded','in_transit')",[id])).rowCount,'ACTIVE_PARCELS','Resolve parcel custody before closing this service.',409);
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
      requirePlatform(actor,'system');
      return reasoning.usage();
    }
    if(method==='GET' && path==='/ops/health') { const h=await health.read(actor); return { ...h, channels: channelAvailability(config),
        // Operational state of the outbound email channel. Counts, states and
        // timestamps only — never a key, never an address, never a subject,
        // never a body. `sent` is LeRoutier's OWN count of accepted sends
        // today and is labelled as such: it is not Brevo's authoritative
        // balance, which the free plan does not expose per-day.
        email: await notify.channelHealth() }; }
    // The Platform Ops user register: searched and paginated server-side, so a
    // console never ships the whole directory to filter it in the browser and
    // never silently stops finding people past a fixed cap.
    if(method==='GET' && path==='/ops/users') return health.users(actor,{q:url.searchParams.get('q'),
      limit:url.searchParams.get('limit'),offset:url.searchParams.get('offset')});
    if(method==='POST' && path==='/ops/model-health') {
      // Platform Ops only: it spends quota, so an operator admin cannot drain
      // the shared budget by refreshing a dashboard.
      requirePlatform(actor,'system');
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
          fedapay:{collections:pay.configured,payouts:await payout.capability(),environment:adapter?.environment ?? null},
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
      // An independent owner-driver manages their own operator, so this is
      // their view of their own published departures. Everything below is
      // already scoped by actor.operator_id.
      invariant(managesOperator(actor),'FORBIDDEN','Operations access required.',403);
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
      if(data instanceof RawResponse) return new Response(data.body,{status:data.status,headers:{...headers,'content-type':data.contentType}});
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
