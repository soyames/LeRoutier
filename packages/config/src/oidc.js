import { UserManager, WebStorageStateStore, InMemoryWebStorage } from 'oidc-client-ts';

const clients=new Map();
const callbacks=new WeakMap();
const RETURN_TO='leroutier:return-to';

// Only a same-origin, absolute path may be returned to after sign-in. Anything
// else — an absolute URL, a protocol-relative "//evil.example", the callback
// route itself — falls back to the home page. This is the open-redirect guard.
export function safeReturnPath(value) {
  if(typeof value!=='string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if(value.startsWith('/auth/callback')) return '/';
  return value;
}

/** Remember where the user was, so sign-in returns them there. */
export function rememberReturnPath(path){
  try{ window.sessionStorage.setItem(RETURN_TO,safeReturnPath(path)); }catch{ /* private mode */ }
}
export function takeReturnPath(){
  try{
    const value=window.sessionStorage.getItem(RETURN_TO);
    window.sessionStorage.removeItem(RETURN_TO);
    return safeReturnPath(value);
  }catch{ return '/'; }
}

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

export function finishSignin(client,url,returnTo='/') {
  // React StrictMode may mount the callback twice. Redeem each code only once.
  // The callback URL is replaced by the page the user actually asked for, so a
  // deep link — and an interrupted booking — survives the provider round trip.
  if(!callbacks.has(client))callbacks.set(client,client.manager.signinRedirectCallback(url).finally(()=>{
    window.history.replaceState({},'',safeReturnPath(returnTo));
  }));
  return callbacks.get(client);
}
export function clearSignin(client){callbacks.delete(client);}
