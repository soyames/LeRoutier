import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/app.js';
import { serverConfig } from '@leroutier/config';

const db={transaction:async fn=>fn({query:async()=>({rows:[]})})};
const config={demoLogin:false,corsOrigins:['https://passenger.example.invalid']};
const api=createApi(db,config);
test('health responds without exposing configuration',async()=>{
  const r=await api(new Request('http://localhost/health'));assert.equal(r.status,200);assert.deepEqual(await r.json(),{data:{status:'ok'}});
});
test('database failure returns only a safe error',async()=>{
  const failed=createApi({transaction:async()=>{throw new Error('Private internal diagnostic');}},config);
  const r=await failed(new Request('http://localhost/health'));assert.equal(r.status,503);assert.ok(!(await r.text()).includes('Private'));
});
test('protected endpoints reject unauthenticated access',async()=>assert.equal((await api(new Request('http://localhost/ops/fleet'))).status,401));
test('demo login is disabled in deployed environments',()=>{
  assert.equal(serverConfig({DATABASE_URL:'placeholder',ALLOW_DEMO_LOGIN:'true',VERCEL:'1'}).demoLogin,false);
  assert.equal(serverConfig({DATABASE_URL:'placeholder',ALLOW_DEMO_LOGIN:'true',NODE_ENV:'production'}).demoLogin,false);
});
test('demo endpoint is absent when disabled',async()=>assert.equal((await api(new Request('http://localhost/auth/demo',{method:'POST'}))).status,404));
test('allowed CORS preflight succeeds',async()=>{
  const r=await api(new Request('http://localhost/bookings',{method:'OPTIONS',headers:{origin:config.corsOrigins[0]}}));
  assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),config.corsOrigins[0]);
});
test('unapproved origins are rejected',async()=>assert.equal((await api(new Request('http://localhost/health',{headers:{origin:'https://untrusted.example.invalid'}}))).status,403));
test('invalid identifiers do not reach SQL',async()=>assert.equal((await api(new Request('http://localhost/services/not-an-id/availability?origin=0&destination=3'))).status,400));
