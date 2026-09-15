import { UserManager, WebStorageStateStore, InMemoryWebStorage } from 'oidc-client-ts';

const clients=new Map();
const callbacks=new WeakMap();
export function oidcClient(base,config) {
  if(!config)return null;
  const redirectUri=window.location.origin+'/auth/callback';
  if(!config.redirectUris.includes(redirectUri))return null;
  const key=JSON.stringify([base,config,redirectUri]);
  if(!clients.has(key))clients.set(key,{
    manager:new UserManager({authority:config.authority,client_id:config.clientId,
      redirect_uri:redirectUri,post_logout_redirect_uri:window.location.origin+'/',
      response_type:'code',scope:config.scope,resource:config.resource || undefined,
      automaticSilentRenew:false,loadUserInfo:false,monitorSession:false,
      userStore:new WebStorageStateStore({store:new InMemoryWebStorage()}),
      stateStore:new WebStorageStateStore({store:window.sessionStorage}),
    }),
  });
  return clients.get(key);
}
export function finishSignin(client,url) {
  // React StrictMode may mount the callback twice. Redeem each code only once.
  if(!callbacks.has(client))callbacks.set(client,client.manager.signinRedirectCallback(url).finally(()=>{
    window.history.replaceState({},'', '/');
  }));
  return callbacks.get(client);
}
export function clearSignin(client){callbacks.delete(client);}
