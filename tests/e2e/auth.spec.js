import { test, expect } from '@playwright/test';
import { mockApi } from './api-fixture.js';
import { jwtFixture } from '../../services/api/tests/jwt-fixture.js';

// Exercise the real PKCE client using ephemeral test keys. Never record tokens,
// authorization headers, callback codes, or provider traffic in test artifacts.
test.use({trace:'off',video:'off',screenshot:'off'});
const origin='https://issuer.example.invalid';
async function provider(page,port,role='passenger',needsProfile=false){
  await mockApi(page);
  const fixture=await jwtFixture(),base=`http://127.0.0.1:${port}`;
  let verifierChallenge='',exchanges=0;
  let user={id:'00000000-0000-4000-8000-000000000099',display_name:needsProfile?'':'Test Identity',role,operator_id:role==='passenger'?null:'00000000-0000-4000-8000-000000000001',needs_profile:needsProfile};
  await page.route('**/auth/config',r=>r.fulfill({json:{data:{demoLogin:false,oidc:{authority:origin,clientId:'browser-test',scope:'openid profile',redirectUris:[base+'/auth/callback']}}}}));
  await page.route(origin+'/.well-known/openid-configuration',r=>r.fulfill({json:{issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',jwks_uri:origin+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']}}));
  await page.route(origin+'/authorize?**',async r=>{
    const url=new URL(r.request().url());
    // Assertions contain only public configuration, never runtime credentials.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
    verifierChallenge=url.searchParams.get('code_challenge');
    const callback=new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code','ephemeral-test-code');
    await r.fulfill({status:302,headers:{location:callback.href}});
  });
  await page.route(origin+'/token',async r=>{
    const form=new URLSearchParams(r.request().postData());
    const {createHash}=await import('node:crypto');
    expect(createHash('sha256').update(form.get('code_verifier') || '').digest('base64url')===verifierChallenge).toBe(true);
    expect(form.has('client_secret')).toBe(false);exchanges++;
    const idToken=await fixture.sign('browser-user',{aud:'browser-test'}),accessToken=await fixture.sign('browser-user');
    await r.fulfill({json:{access_token:accessToken,id_token:idToken,token_type:'Bearer',expires_in:600}});
  });
  await page.route('**/me',async r=>{
    if(r.request().method()==='PATCH'){
      const body=r.request().postDataJSON();expect(Object.keys(body).sort()).toEqual(['displayName','phone']);
      user={...user,display_name:body.displayName,needs_profile:false};
    }
    await r.fulfill({json:{data:user}});
  });
  await page.goto(base+'/');
  return {exchanges:()=>exchanges};
}

test('production login unavailable fails closed without token input or demo login',async({page})=>{
  await mockApi(page);await page.route('**/auth/config',r=>r.fulfill({json:{data:{demoLogin:false,oidc:null}}}));
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.getByRole('button',{name:'Se connecter',exact:true})).toBeDisabled();
  await expect(page.getByText('La connexion sécurisée n’est pas encore configurée.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Connexion de développement'})).toHaveCount(0);
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});
test('passenger signs in with PKCE, completes profile and signs out without persistent tokens',async({page})=>{
  const state=await provider(page,4173,'passenger',true);
  await page.getByRole('button',{name:'Se connecter',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Complétez votre profil'})).toBeVisible();
  expect(state.exchanges()).toBe(1);
  await expect(page.getByRole('button',{name:'Complétez votre profil'})).toBeDisabled();
  await page.getByLabel('Nom complet').fill('Voyageur Test');await page.getByLabel('Téléphone',{exact:true}).fill('');
  await page.getByRole('button',{name:'Enregistrer mon profil'}).click();
  await expect(page.getByRole('button',{name:'Réserver une place'})).toBeEnabled();
  expect(await page.evaluate(()=>Object.keys(localStorage).length+Object.keys(sessionStorage).filter(k=>k.startsWith('oidc.')).length)).toBe(0);
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await page.getByRole('button',{name:'Déconnexion'}).click();
  await expect(page.getByRole('button',{name:'Se connecter',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Se connecter pour réserver'})).toBeEnabled();
});
test('callback without matching state is rejected',async({page})=>{
  await provider(page,4173);
  await page.goto('http://127.0.0.1:4173/auth/callback?code=invalid-test-code&state=unrecognized-test-state');
  await expect(page.getByRole('alert')).toHaveText('Connexion refusée ou expirée. Réessayez.');
  await expect(page.getByRole('button',{name:'Déconnexion'})).toHaveCount(0);
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
});
test('driver app shows explicit unprovisioned state for passenger identity',async({page})=>{
  await provider(page,4174);await page.getByRole('button',{name:'Se connecter',exact:true}).click();
  await expect(page.getByText('Votre compte passager n’est pas encore provisionné comme équipage. Créez un compte opérateur ou demandez votre provisionnement.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Déconnexion'})).toBeVisible();
});
test('ops app denies passenger identity and hides provisioning controls',async({page})=>{
  await provider(page,4175);await page.getByRole('button',{name:'Se connecter',exact:true}).click();
  await expect(page.getByText('Votre compte passager n’a pas accès au centre opérationnel. Créez un compte opérateur (compagnie) pour administrer.')).toBeVisible();
  await expect(page.getByText('Provisionner un agent Ops',{exact:true})).toHaveCount(0);
});
test('approved driver sees assignment and signout clears privileged data',async({page})=>{
  await provider(page,4174,'driver');await page.getByRole('button',{name:'Se connecter',exact:true}).click();
  await expect(page.getByText('DEMO-BUS-01',{exact:false}).first()).toBeVisible();
  await page.getByRole('button',{name:'Déconnexion'}).click();
  await expect(page.getByText('DEMO-BUS-01',{exact:false})).toHaveCount(0);
});
test('operator ops can create a vehicle with a stable retry key and no fake success',async({page})=>{
  await provider(page,4175,'ops');
  await page.route('**/ops/provisioning',r=>r.fulfill({json:{data:{operators:[{id:'00000000-0000-4000-8000-000000000001',name:'Test operator'}],users:[],routes:[],vehicles:[],places:[],stops:[]}}}));
  let attempts=0,firstKey;
  await page.route('**/ops/vehicles',r=>{
    const key=r.request().headers()['idempotency-key'];if(!attempts)firstKey=key;else expect(key===firstKey).toBe(true);
    expect(r.request().postDataJSON()).toEqual({operatorId:'00000000-0000-4000-8000-000000000001',registration:'TEST-01',capacity:12});
    return ++attempts===1?r.fulfill({status:503,json:{error:{message:'Réessayez.'}}}):r.fulfill({json:{data:{id:'created'}}});
  });
  await page.getByRole('button',{name:'Se connecter',exact:true}).click();
  // Sessions are memory-only: navigate client-side, never reload the app.
  await page.getByRole('button',{name:'Paramètres'}).click();
  await expect(page.getByText('Créer un opérateur',{exact:true})).toHaveCount(0);
  await page.getByText('Ajouter un véhicule',{exact:true}).click();
  await page.getByLabel('Immatriculation').fill('TEST-01');await page.getByLabel('Nombre de places').fill('12');
  const form=page.locator('details').filter({has:page.getByText('Ajouter un véhicule',{exact:true})});
  await form.getByRole('button',{name:'Enregistrer',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('Réessayez.');
  await expect(page.getByText('Création enregistrée.')).toHaveCount(0);
  await form.getByRole('button',{name:'Enregistrer',exact:true}).click();await expect(page.getByText('Création enregistrée.')).toBeVisible();
});
