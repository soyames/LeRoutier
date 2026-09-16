import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/app.js';
import { serverConfig } from '@leroutier/config';

const db={transaction:async fn=>fn({query:async()=>({rows:[]})})};
const config={demoLogin:false,corsOrigins:['https://passenger.example.invalid']};
const api=createApi(db,config);
test('health responds without exposing configuration',async()=>{
  const r=await api(new Request('http://localhost/api/v1/health'));assert.equal(r.status,200);assert.deepEqual(await r.json(),{data:{status:'ok'}});
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

test('responses state that the API is not a document',async()=>{
  const r=await api(new Request('http://localhost/api/v1/health'));
  assert.equal(r.headers.get('x-frame-options'),'DENY');
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  assert.equal(r.headers.get('referrer-policy'),'no-referrer');
  assert.match(r.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);
  assert.equal(r.headers.get('cache-control'),'no-store');
});
