import { before,test } from 'node:test';
import assert from 'node:assert/strict';
import { jwtVerifier } from '../src/auth.js';
import { publicAuthConfig } from '@leroutier/config';
import { jwtFixture } from './jwt-fixture.js';
let fixture,verify;
before(async()=>{fixture=await jwtFixture();verify=jwtVerifier(fixture.config,fixture.resolver);});
test('valid signature returns only the identity claims LeRoutier reads',async()=>{
  assert.deepEqual(await verify(await fixture.sign('person',{role:'ops',operator_id:'untrusted'})),
    {subject:'person',issuer:fixture.config.issuer,email:null,notificationEmail:null,emailVerified:false,signInProvider:null});
});
test('only a verified email claim can receive confirmation mail',async()=>{
  assert.equal((await verify(await fixture.sign('person',{email:'test@example.invalid',email_verified:false}))).notificationEmail,null);
  assert.equal((await verify(await fixture.sign('person',{email:'test@example.invalid',email_verified:true}))).notificationEmail,'test@example.invalid');
});
test('the verification gate reads the provider claim and the verified flag separately',async()=>{
  const unverified=await verify(await fixture.sign('person',{email:'test@example.invalid',email_verified:false,firebase:{sign_in_provider:'password'}}));
  assert.deepEqual({email:unverified.email,notificationEmail:unverified.notificationEmail,emailVerified:unverified.emailVerified,signInProvider:unverified.signInProvider},
    {email:'test@example.invalid',notificationEmail:null,emailVerified:false,signInProvider:'password'});
  const google=await verify(await fixture.sign('person',{email:'test@example.invalid',email_verified:false,firebase:{sign_in_provider:'google.com'}}));
  assert.equal(google.signInProvider,'google.com');
  assert.equal(google.emailVerified,false);
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
const FIREBASE_WEB={apiKey:'web-api-key',authDomain:'example.firebaseapp.com',projectId:'example-project',appId:'1:1:web:1'};
test('public sign-in config stays unavailable until complete',()=>{
  assert.equal(publicAuthConfig({demoLogin:false}).firebase,null);
  // Every field is required: a half-configured Firebase app produces a sign-in
  // button that fails only after the user has committed to using it.
  for(const missing of ['apiKey','authDomain','appId']) {
    assert.equal(publicAuthConfig({firebaseProjectId:'example-project',firebaseWeb:{...FIREBASE_WEB,[missing]:undefined}}).firebase,null,
      `${missing} missing must disable sign-in`);
  }
  assert.equal(publicAuthConfig({firebaseWeb:FIREBASE_WEB}).firebase,null,'no project id must disable sign-in');
});
test('public sign-in config carries only browser-facing Firebase identifiers',()=>{
  const result=publicAuthConfig({googleAuthEnabled:true,firebaseProjectId:'example-project',firebaseWeb:FIREBASE_WEB,
    databaseUrl:'private-placeholder',fedapay:{secretKey:'sk-private'},issuer:'https://securetoken.google.com/example-project'});
  assert.deepEqual(Object.keys(result.firebase).sort(),['apiKey','appId','authDomain','projectId','providers']);
  assert.deepEqual(result.firebase.providers,['google']);
  // Nothing server-side may ride along: not a credential, and not even the
  // issuer or key set the API verifies against.
  const text=JSON.stringify(result);
  for(const secret of ['private-placeholder','sk-private','securetoken.google.com','jwks']) {
    assert.equal(text.includes(secret),false,`${secret} reached the browser payload`);
  }
});

test('Google is hidden by default and e-mail/password configuration survives it',()=>{
  // Production sets no flag; the published provider list must then be empty
  // while the Firebase identifiers that e-mail/password needs stay present.
  const result=publicAuthConfig({firebaseProjectId:'example-project',firebaseWeb:FIREBASE_WEB});
  assert.deepEqual(result.firebase.providers,[]);
  assert.equal(result.firebase.appId,FIREBASE_WEB.appId);
});
