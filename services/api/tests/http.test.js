import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/app.js';
import { serverConfig } from '@leroutier/config';
import * as nodeCrypto from 'node:crypto';

const db={transaction:async fn=>fn({query:async()=>({rows:[]})})};
const config={demoLogin:false,corsOrigins:['https://passenger.example.invalid']};
const api=createApi(db,config);
test('health responds without exposing configuration',async()=>{
  const r=await api(new Request('http://localhost/api/v1/health'));assert.equal(r.status,200);assert.deepEqual(await r.json(),{data:{status:'ok'}});
});
test('request identifiers correlate responses without accepting arbitrary header content',async()=>{
  const id=nodeCrypto.randomUUID();
  const response=await api(new Request('http://localhost/api/v1/health',{headers:{'x-request-id':id}}));
  assert.equal(response.headers.get('x-request-id'),id);
  const failure=await api(new Request('http://localhost/api/v1/missing',{headers:{'x-request-id':'private-token'}}));
  assert.notEqual(failure.headers.get('x-request-id'),'private-token');
  assert.equal((await failure.json()).error.requestId,failure.headers.get('x-request-id'));
});
test('database failure returns only a safe error',async()=>{
  const failed=createApi({transaction:async()=>{throw new Error('Private internal diagnostic');}},config);
  const r=await failed(new Request('http://localhost/api/v1/health'));assert.equal(r.status,503);assert.ok(!(await r.text()).includes('Private'));
});
test('protected endpoints reject unauthenticated access',async()=>assert.equal((await api(new Request('http://localhost/api/v1/ops/fleet'))).status,401));
test('demo login is disabled in deployed environments',()=>{
  assert.equal(serverConfig({DATABASE_URL:'placeholder',ALLOW_DEMO_LOGIN:'true',VERCEL:'1'}).demoLogin,false);
  assert.equal(serverConfig({DATABASE_URL:'placeholder',ALLOW_DEMO_LOGIN:'true',NODE_ENV:'production'}).demoLogin,false);
});
test('demo endpoint is absent when disabled',async()=>assert.equal((await api(new Request('http://localhost/api/v1/auth/demo',{method:'POST'}))).status,404));
test('allowed CORS preflight succeeds',async()=>{
  const r=await api(new Request('http://localhost/api/v1/bookings',{method:'OPTIONS',headers:{origin:config.corsOrigins[0]}}));
  assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),config.corsOrigins[0]);
});
test('unapproved origins are rejected',async()=>assert.equal((await api(new Request('http://localhost/api/v1/health',{headers:{origin:'https://untrusted.example.invalid'}}))).status,403));
test('invalid identifiers do not reach SQL',async()=>assert.equal((await api(new Request('http://localhost/api/v1/services/not-an-id/availability?origin=0&destination=3'))).status,400));

// A database that answers the rate-limit counter and records what it was asked,
// so metering can be observed without a real PostgreSQL.
function metered({requests=1}={}) {
  const subjects=[];
  const stub={transaction:async fn=>fn({query:async(sql,params)=>{
    if(/request_limits/.test(sql)) {subjects.push(params[0]);return {rows:[{requests}]};}
    return {rows:[]};
  }})};
  return {api:createApi(stub,config),subjects};
}

test('anonymous catalogue reads are rate limited per client address',async()=>{
  for(const path of ['/stops','/places','/routes','/services']) {
    const {api:metrics,subjects}=metered();
    await metrics(new Request('http://localhost/api/v1'+path,{headers:{'x-forwarded-for':'203.0.113.7, 10.0.0.1'}}));
    assert.deepEqual(subjects,['public-catalogue:203.0.113.7'],`${path} was not metered`);
  }
});

test('an over-limit anonymous read is refused',async()=>{
  const {api:metrics}=metered({requests:121});
  assert.equal((await metrics(new Request('http://localhost/api/v1/routes'))).status,429);
});

test('a malformed identifier is refused without costing a database write',async()=>{
  const {api:metrics,subjects}=metered();
  assert.equal((await metrics(new Request('http://localhost/api/v1/services/not-an-id/availability?origin=0&destination=3'))).status,400);
  assert.deepEqual(subjects,[],'rejecting bad input must not consume the limiter');
});

// ------------------------------------------------------------ journey-plan --
// The geography model: place ids resolve to coordinates before planning, so a
// place that is not a stop still plans — and an empty catalogue stays honest.
test('journey-plan resolves place ids to coordinates and answers honestly on an empty catalogue',async()=>{
  const cid=nodeCrypto.randomUUID(),pid=nodeCrypto.randomUUID();
  const places={[cid]:{id:cid,name:'Cotonou',kind:'city',latitude:'6.37',longitude:'2.39'},
    [pid]:{id:pid,name:'Parakou',kind:'city',latitude:'9.34',longitude:'2.63'}};
  const stub={transaction:async fn=>fn({query:async(sql,params)=>{
    if(/FROM places WHERE id=\$1 AND latitude IS NOT NULL/.test(sql)) return {rows:places[params[0]]?[places[params[0]]]:[]};
    return {rows:[]};
  }})};
  const api=createApi(stub,config);
  const r=await api(new Request(`http://localhost/api/v1/journey-plan?originPlaceId=${cid}&destinationPlaceId=${pid}`));
  assert.equal(r.status,200);
  const body=await r.json();
  assert.deepEqual(body.data.options,[],'an empty transport catalogue plans to zero options, honestly');
  assert.equal(typeof body.data.generatedAt,'string');
  // A place id that does not resolve is a clean 404, not a silent empty plan.
  const missing=await api(new Request(`http://localhost/api/v1/journey-plan?originPlaceId=${nodeCrypto.randomUUID()}&destinationPlaceId=${pid}`));
  assert.equal(missing.status,404);
});

// ------------------------------------------------------------------ USSD ----
// The gateway callback is the one public endpoint that mutates. These tests
// guard the door; the journeys behind it live in the database suite.
const USSD_SECRET='gateway-shared-secret';
const ussdConfig={...config,ussd:{provider:'generic',webhookSecret:USSD_SECRET,sessionTtlSeconds:180,defaultLocale:'fr'}};
// Answers the rate-limit counter; every other query returns nothing, so the
// engine reaches its own failure path. That is the point here: these tests
// guard the door and the protocol, not the journeys — those need a real
// database and live in packages/database/tests/ussd.test.js.
const gatewayDb={transaction:async fn=>fn({query:async sql=>(/request_limits/.test(sql)?{rows:[{requests:1}]}:{rows:[]})})};
const ussdApi=createApi(gatewayDb,ussdConfig);
const signed=body=>{
  const {createHmac}=nodeCrypto;
  return new Request('http://localhost/api/v1/ussd/webhook/generic',{method:'POST',
    headers:{'content-type':'application/json','x-ussd-signature':createHmac('sha256',USSD_SECRET).update(body).digest('hex')},body});
};

test('the USSD endpoint does not exist unless a provider is configured',async()=>{
  const r=await api(new Request('http://localhost/api/v1/ussd/webhook/generic',{method:'POST',body:'{}'}));
  assert.equal(r.status,404,'an unconfigured deployment must not expose a gateway endpoint');
});

test('only the configured provider is answered',async()=>{
  for(const name of ['sandbox','unknown','generic2']) {
    const r=await ussdApi(new Request(`http://localhost/api/v1/ussd/webhook/${name}`,{method:'POST',body:'{}'}));
    assert.equal(r.status,404,`${name} must not be reachable when 'generic' is configured`);
  }
});

test('a correctly signed callback is answered in the gateway protocol',async()=>{
  const r=await ussdApi(signed(JSON.stringify({sessionId:'s-1',msisdn:'+22961000001',text:''})));
  assert.equal(r.status,200);
  assert.match(r.headers.get('content-type')??'',/text\/plain/);
  const body=await r.text();
  assert.match(body,/^(CON|END) /,'a gateway expects CON or END');
});

test('an unsigned callback is still answered, but can never authenticate',async()=>{
  // Leaving a gateway hanging is worse than answering: it retries, and the
  // caller sees nothing. So it gets a screen — just never an identity.
  const r=await ussdApi(new Request('http://localhost/api/v1/ussd/webhook/generic',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'s-2',msisdn:'+22961000001',text:''})}));
  assert.equal(r.status,200);
  assert.match(await r.text(),/^(CON|END) /);
});

test('a tampered body fails verification',async()=>{
  const body=JSON.stringify({sessionId:'s-3',msisdn:'+22961000001',text:''});
  const request=signed(body);
  const tampered=new Request('http://localhost/api/v1/ussd/webhook/generic',{method:'POST',
    headers:request.headers,body:JSON.stringify({sessionId:'s-3',msisdn:'+22999999999',text:''})});
  const r=await ussdApi(tampered);
  // Answered, unverified — the swapped MSISDN cannot become an identity.
  assert.equal(r.status,200);
});

test('an oversized callback is refused before anything is parsed',async()=>{
  const r=await ussdApi(new Request('http://localhost/api/v1/ussd/webhook/generic',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'s',text:'x'.repeat(9000)})}));
  assert.equal(r.status,413);
});

test('a malformed callback body is refused safely',async()=>{
  const r=await ussdApi(new Request('http://localhost/api/v1/ussd/webhook/generic',{method:'POST',
    headers:{'content-type':'application/json'},body:'{not json'}));
  assert.equal(r.status,400);
  assert.equal(/stack|SyntaxError|position/i.test(await r.text()),false,'no parser internals reach a gateway');
});

test('a form-encoded gateway is understood as readily as a JSON one',async()=>{
  const body='sessionId=s-4&msisdn=%2B22961000001&text=';
  const r=await ussdApi(new Request('http://localhost/api/v1/ussd/webhook/generic',{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},body}));
  assert.equal(r.status,200);
  assert.match(await r.text(),/^(CON|END) /);
});

test('responses state that the API is not a document',async()=>{
  const r=await api(new Request('http://localhost/api/v1/health'));
  assert.equal(r.headers.get('x-frame-options'),'DENY');
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  assert.equal(r.headers.get('referrer-policy'),'no-referrer');
  assert.match(r.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);
  assert.equal(r.headers.get('cache-control'),'no-store');
});
