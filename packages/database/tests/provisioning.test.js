import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { provisioning,bootstrap } from '../src/provisioning.js';
import { activeIdentity } from '../src/identities.js';
import { serverConfig } from '@leroutier/config';
import { createApi } from '../../../services/api/src/app.js';
import { jwtFixture } from '../../../services/api/tests/jwt-fixture.js';

const db=createDatabase({...serverConfig(),schema:'lr_test_'+randomUUID().replaceAll('-','')});
let fixture,api,provision,platform,alphaOps,betaOps,alphaDriver,betaDriver,operatorA,operatorB,service,passenger,otherPassenger,bootstrapInput;
const actor=id=>db.transaction(tx=>activeIdentity(tx,id));
async function call(subject,path,method='GET',body=undefined,claims={}){
  const jwt=await fixture.sign(subject,claims);
  const response=await api(new Request('http://localhost'+path,{method,headers:{authorization:'Bearer '+jwt,'content-type':'application/json','idempotency-key':randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {status:response.status,...await response.json()};
}
before(async()=>{
  await migrate(db);fixture=await jwtFixture();provision=provisioning(db,fixture.config);
  api=createApi(db,{...serverConfig(),...fixture.config,demoLogin:false},fixture.resolver);
  bootstrapInput={operatorKey:'test-alpha',operatorName:'Test Alpha',opsSubject:'test-platform',opsName:'Platform Test',issuer:fixture.config.issuer,platformOps:true,
    driver:{subject:'bootstrap-driver',displayName:'Bootstrap Driver',licenseReference:'TEST-BOOTSTRAP'}};
  const initial=await bootstrap(db,bootstrapInput);operatorA=initial.operatorId;platform=await actor(initial.opsUserId);
  operatorB=(await provision.operator(platform,{key:'test-beta',name:'Test Beta'},randomUUID())).id;
  alphaOps=await provision.opsUser(platform,{subject:'alpha-ops',displayName:'Alpha Ops',operatorId:operatorA},randomUUID());
  betaOps=await provision.opsUser(platform,{subject:'beta-ops',displayName:'Beta Ops',operatorId:operatorB},randomUUID());
  alphaDriver=await provision.driver(alphaOps,{subject:'alpha-driver',displayName:'Alpha Driver',operatorId:operatorA,licenseReference:'TEST-A'},randomUUID());
  betaDriver=await provision.driver(betaOps,{subject:'beta-driver',displayName:'Beta Driver',operatorId:operatorB,licenseReference:'TEST-B'},randomUUID());
});
after(async()=>{try{await dropDisposableSchema(db);}finally{await db.close();}});
test('bootstrap is idempotent and closes against different inputs',async()=>{
  assert.equal((await bootstrap(db,bootstrapInput)).opsUserId,platform.id);
  await assert.rejects(bootstrap(db,{...bootstrapInput,opsSubject:'another-person'}),{code:'BOOTSTRAP_CONFLICT'});
});
test('first login is idempotent and ignores JWT privilege claims',async()=>{
  const results=await Promise.all([call('new-passenger','/api/v1/me','GET',undefined,{role:'ops'}),call('new-passenger','/api/v1/me')]);
  assert.equal(results[0].data.id,results[1].data.id);passenger=results[0].data;
  assert.equal(passenger.role,'passenger');assert.equal(passenger.operator_id,null);assert.equal(passenger.needs_profile,true);
  otherPassenger=(await call('other-passenger','/api/v1/me')).data;
});
test('passenger completes own profile without privilege fields',async()=>{
  const result=await call('new-passenger','/api/v1/me','PATCH',{displayName:'Passenger Test',phone:'+229 0100000000'});
  assert.equal(result.status,200);assert.equal(result.data.needs_profile,false);
});

test('profile updates preserve omitted phone and accept explicit empty optional phone',async()=>{
  const update=await call('new-passenger','/api/v1/me','PATCH',{displayName:'Passenger Test'});
  assert.equal(update.status,200);assert.equal(update.data.phone,'+229 0100000000');
  assert.equal((await call('new-passenger','/api/v1/me','PATCH',{displayName:'Passenger Test',phone:null})).data.phone,null);
});

for(const [name,claims] of [['expired',{exp:1}],['wrong issuer',{iss:'https://wrong.example.invalid'}],['wrong audience',{aud:'wrong-api'}]]){
  test(`API rejects ${name} JWT before identity creation`,async()=>{
    assert.equal((await call('must-not-exist','/api/v1/me','GET',undefined,claims)).status,401);
    const count=await db.transaction(async tx=>(await tx.query("SELECT count(*)::integer AS n FROM users WHERE auth_subject='must-not-exist'")).rows[0].n);
    assert.equal(count,0);
  });
}
test('API rejects malformed JWT and invalid signature',async()=>{
  const other=await jwtFixture();
  for(const jwt of ['invalid.jwt.input',await other.sign('must-not-exist')])assert.equal((await api(new Request('http://localhost/api/v1/me',{headers:{authorization:'Bearer '+jwt}}))).status,401);
});

// An opaque bearer token is the single most likely production misconfiguration:
// most providers issue one by default and it looks like a working login right
// up to the first API call.
test('API rejects an opaque access token rather than treating it as a session',async()=>{
  for(const opaque of ['s7YkQ2m1Np8vRt4Lw0Zx','opaque-token-without-dots','a.b']) {
    const response=await api(new Request('http://localhost/api/v1/me',{headers:{authorization:'Bearer '+opaque}}));
    assert.equal(response.status,401,`opaque token "${opaque.slice(0,6)}…" must not authenticate`);
  }
  const count=await db.transaction(async tx=>(await tx.query('SELECT count(*)::integer AS n FROM users')).rows[0].n);
  assert.ok(count>0,'the rejection path must not have disturbed existing identities');
});

test('API rejects a token signed with an unknown key id, without leaking why',async()=>{
  const response=await api(new Request('http://localhost/api/v1/me',
    {headers:{authorization:'Bearer '+await fixture.sign('must-not-exist',{},{kid:'rotated-away'})}}));
  assert.equal(response.status,401);
  const body=await response.json();
  assert.equal(body.error.message,'Session is invalid or expired.','the reason is never disclosed to the caller');
  assert.equal(/kid|jwks|key/i.test(JSON.stringify(body)),false);
});

// Some providers put MULTIPLE values in `aud`. Firebase uses a single project
// id, but the verifier must accept a token whose audience *contains* the
// configured one — and still refuse one that merely looks similar.
test('a multi-valued audience containing the project id is accepted',async()=>{
  const multi=await call('multi-aud-user','/api/v1/me','GET',undefined,
    {aud:['some-other-client-id',fixture.config.audience,'the-project-id']});
  assert.equal(multi.status,200);
  assert.equal(multi.data.role,'passenger');
  // ...and one that merely looks similar is still refused.
  assert.equal((await call('must-not-exist','/api/v1/me','GET',undefined,
    {aud:['other-client','not-our-api']})).status,401);
});

test('an ES256-signed token is accepted, like the RS256 one',async()=>{
  // Both are advertised as supported; a provider signing with the untested one
  // would otherwise be a production discovery.
  const es=await jwtFixture('ES256');
  const esApi=createApi(db,{...serverConfig(),...es.config,demoLogin:false},es.resolver);
  const response=await esApi(new Request('http://localhost/api/v1/me',
    {headers:{authorization:'Bearer '+await es.sign('es256-user')}}));
  assert.equal(response.status,200);
  assert.equal((await response.json()).data.role,'passenger');
});

test('an unsupported algorithm is refused even with otherwise perfect claims',async()=>{
  const hs=await fixture.signSymmetric('must-not-exist');
  assert.equal((await api(new Request('http://localhost/api/v1/me',{headers:{authorization:'Bearer '+hs}}))).status,401);
  const count=await db.transaction(async tx=>(await tx.query("SELECT count(*)::integer AS n FROM users WHERE auth_subject='must-not-exist'")).rows[0].n);
  assert.equal(count,0);
});

test('inactive operator disables its identities',async()=>{
  await db.transaction(tx=>tx.query('UPDATE operators SET active=false WHERE id=$1',[operatorB]));
  assert.equal((await call('beta-ops','/api/v1/ops/fleet')).status,403);
  assert.equal((await call('beta-driver','/api/v1/driver/service')).status,403);
  await db.transaction(tx=>tx.query('UPDATE operators SET active=true WHERE id=$1',[operatorB]));
});
test('self-promotion and operator spoofing are rejected',async()=>{
  for(const field of [{role:'ops'},{role:'driver'},{operatorId:operatorA},{active:true},{auth_subject:'alpha-ops'}]) {
    assert.equal((await call('new-passenger','/api/v1/me','PATCH',{displayName:'Passenger Test',...field})).status,400);
  }
  assert.equal((await call('new-passenger','/api/v1/me')).data.role,'passenger');
});
test('passenger cannot access ops or driver endpoints',async()=>{
  assert.equal((await call('new-passenger','/api/v1/ops/fleet')).status,403);
  assert.equal((await call('new-passenger','/api/v1/driver/service')).status,403);
  assert.equal((await call('new-passenger','/api/v1/ops/ops-users','POST',{subject:'attacker',displayName:'Attacker',operatorId:operatorA})).status,403);
});
test('driver cannot invoke privileged provisioning',async()=>{
  assert.equal((await call('alpha-driver','/api/v1/ops/vehicles','POST',{operatorId:operatorA,registration:'NOPE',capacity:12})).status,403);
});
test('operator ops cannot create another operator or grant platform privileges',async()=>{
  await assert.rejects(provision.operator(alphaOps,{key:'not-permitted',name:'Not permitted'},randomUUID()),{code:'FORBIDDEN'});
  await assert.rejects(provision.opsUser(alphaOps,{subject:'global-attempt',displayName:'Invalid',operatorId:null},randomUUID()));
});
test('cross-operator staff provisioning and activation are rejected',async()=>{
  await assert.rejects(provision.driver(alphaOps,{subject:'cross-driver',displayName:'Cross',operatorId:operatorB,licenseReference:'TEST-X'},randomUUID()),{code:'FORBIDDEN'});
  await assert.rejects(provision.userStatus(alphaOps,betaDriver.id,{active:false},randomUUID()),{code:'FORBIDDEN'});
  assert.ok(!(await provision.catalog(alphaOps)).users.some(u=>u.id===betaDriver.id));
});
test('disabled identities and inactive driver profiles fail closed',async()=>{
  await provision.userStatus(betaOps,betaDriver.id,{active:false},randomUUID());
  assert.equal((await call('beta-driver','/api/v1/me')).status,403);
  await provision.userStatus(betaOps,betaDriver.id,{active:true},randomUUID());
  await db.transaction(tx=>tx.query('UPDATE driver_profiles SET active=false WHERE user_id=$1',[betaDriver.id]));
  assert.equal((await call('beta-driver','/api/v1/driver/service')).status,403);
  await db.transaction(tx=>tx.query('UPDATE driver_profiles SET active=true WHERE user_id=$1',[betaDriver.id]));
});
test('known subject cannot be rebound to a different issuer',async()=>{
  const otherApi=createApi(db,{...serverConfig(),...fixture.config,issuer:'https://other.example.invalid',demoLogin:false},fixture.resolver);
  const jwt=await fixture.sign('alpha-ops',{iss:'https://other.example.invalid'});
  assert.equal((await otherApi(new Request('http://localhost/api/v1/me',{headers:{authorization:'Bearer '+jwt}}))).status,401);
});
test('ops provisions stops, ordered route, fares, vehicle and service atomically',async()=>{
  const place1=await provision.place(alphaOps,{name:'Cotonou test'},randomUUID()),place2=await provision.place(alphaOps,{name:'Bohicon test'},randomUUID());
  const stop1=await provision.stop(alphaOps,{name:'Test stop A',placeId:place1.id,latitude:6.36,longitude:2.43},randomUUID());
  const stop2=await provision.stop(alphaOps,{name:'Test stop B',placeId:place2.id,latitude:7.18,longitude:2.07},randomUUID());
  await assert.rejects(provision.route(alphaOps,{name:'Bad route',operatorId:operatorA,stops:[{stopId:stop1.id,fareToNext:1},{stopId:stop1.id,fareToNext:0}]},randomUUID()),{code:'INVALID_JOURNEY'});
  const route=await provision.route(alphaOps,{name:'Test route',operatorId:operatorA,stops:[{stopId:stop1.id,fareToNext:2500},{stopId:stop2.id,fareToNext:0}]},randomUUID());
  const key=randomUUID(),input={operatorId:operatorA,registration:'TEST-A-01',capacity:12};
  const vehicle=await provision.vehicle(alphaOps,input,key);assert.equal((await provision.vehicle(alphaOps,input,key)).id,vehicle.id);
  await assert.rejects(provision.vehicle(alphaOps,{...input,capacity:13},key),{code:'IDEMPOTENCY_CONFLICT'});
  const serviceInput={routeId:route.id,vehicleId:vehicle.id,driverId:alphaDriver.id,departureAt:new Date(Date.now()+86400_000).toISOString()};
  await assert.rejects(provision.service(betaOps,serviceInput,randomUUID()),{code:'FORBIDDEN'});
  await assert.rejects(provision.service(alphaOps,{...serviceInput,driverId:betaDriver.id},randomUUID()),{code:'FORBIDDEN'});
  service=await provision.service(alphaOps,serviceInput,randomUUID());
  assert.equal(service.capacity,12);assert.equal(service.is_demo,false);
  assert.equal((await call('new-passenger',`/api/v1/services/${service.id}/availability?origin=0&destination=1`)).data.fare.amountMinor,2500);
});
test('assignments prevent duplicate scheduling and disabling an assigned driver',async()=>{
  const assignment=await db.transaction(async tx=>(await tx.query('SELECT * FROM service_assignments WHERE service_id=$1',[service.id])).rows[0]);
  await assert.rejects(provision.service(alphaOps,{routeId:service.route_id,vehicleId:assignment.vehicle_id,driverId:alphaDriver.id,departureAt:new Date(Date.now()+86400_000).toISOString()},randomUUID()),{code:'ASSIGNMENT_CONFLICT'});
  await assert.rejects(provision.userStatus(alphaOps,alphaDriver.id,{active:false},randomUUID()),{code:'DRIVER_ASSIGNED'});
});
test('cross-operator manifests, service actions and fleet access are scoped',async()=>{
  assert.equal((await call('beta-driver',`/api/v1/services/${service.id}/manifest`)).status,403);
  assert.equal((await call('beta-ops',`/api/v1/services/${service.id}/status`,'POST',{status:'active'})).status,403);
  assert.ok(!(await call('beta-ops','/api/v1/ops/fleet')).data.services.some(s=>s.id===service.id));
});
test('passengers cannot retrieve another passengers booking',async()=>{
  const booked=await call('new-passenger','/api/v1/bookings','POST',{serviceId:service.id,origin:0,destination:1});assert.equal(booked.status,200);
  assert.equal((await call('other-passenger',`/api/v1/bookings/${booked.data.id}`)).status,403);
  assert.notEqual(passenger.id,otherPassenger.id);
});
test('provisioning and role assignments append audit and outbox records',async()=>{
  const actions=await db.transaction(async tx=>(await tx.query('SELECT action FROM audit_events')).rows.map(r=>r.action));
  for(const action of ['identity.role_assigned','operator.created','place.created','stop.created','route.created','vehicle.created','service.provisioned','identity.activation_changed'])assert.ok(actions.includes(action));
  await assert.rejects(db.transaction(tx=>tx.query("UPDATE audit_events SET action='tamper'")),{code:'23514'});
});
