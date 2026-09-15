import { before,test } from 'node:test';
import assert from 'node:assert/strict';
import { jwtVerifier } from '../src/auth.js';
import { publicAuthConfig } from '@leroutier/config';
import { jwtFixture } from './jwt-fixture.js';
let fixture,verify;
before(async()=>{fixture=await jwtFixture();verify=jwtVerifier(fixture.config,fixture.resolver);});
test('valid signature returns only verified subject and issuer',async()=>{
  assert.deepEqual(await verify(await fixture.sign('person',{role:'ops',operator_id:'untrusted'})),{subject:'person',issuer:fixture.config.issuer});
});
test('malformed JWT is rejected',async()=>assert.rejects(verify('invalid.jwt.input'),{code:'UNAUTHORIZED'}));
test('JWT with another signing key is rejected',async()=>{const other=await jwtFixture();await assert.rejects(verify(await other.sign('person')),{code:'UNAUTHORIZED'});});
test('expired JWT is rejected',async()=>assert.rejects(verify(await fixture.sign('person',{exp:Math.floor(Date.now()/1000)-30})),{code:'UNAUTHORIZED'}));
test('wrong issuer is rejected',async()=>assert.rejects(verify(await fixture.sign('person',{iss:'https://other.example.invalid'})),{code:'UNAUTHORIZED'}));
test('wrong audience is rejected',async()=>assert.rejects(verify(await fixture.sign('person',{aud:'other-api'})),{code:'UNAUTHORIZED'}));
test('missing expiry is rejected',async()=>assert.rejects(verify(await fixture.sign('person',{exp:undefined})),{code:'UNAUTHORIZED'}));
test('missing subject is rejected',async()=>assert.rejects(verify(await fixture.sign(undefined)),{code:'UNAUTHORIZED'}));
test('not-before time is enforced',async()=>assert.rejects(verify(await fixture.sign('person',{nbf:Math.floor(Date.now()/1000)+300})),{code:'UNAUTHORIZED'}));
test('unconfigured verifier fails closed',async()=>assert.rejects(jwtVerifier({})(await fixture.sign('person')),{code:'AUTH_UNAVAILABLE'}));
test('public sign-in config stays unavailable until complete',()=>{
  assert.equal(publicAuthConfig({...fixture.config,demoLogin:false}).oidc,null);
  assert.equal(publicAuthConfig({...fixture.config,oidcClientId:'public-client',oidcRedirectUris:['http://unsafe.example.invalid/callback']}).oidc,null);
});
test('public sign-in config contains only public OIDC settings',()=>{
  const result=publicAuthConfig({...fixture.config,oidcClientId:'public-client',oidcRedirectUris:['https://app.example.invalid/auth/callback'],databaseUrl:'private-placeholder'});
  assert.equal(result.oidc.clientId,'public-client');assert.ok(!JSON.stringify(result).includes('private-placeholder'));
});
