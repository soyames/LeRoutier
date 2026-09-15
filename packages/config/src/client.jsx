import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { oidcClient, finishSignin, clearSignin } from './oidc.js';

const Context=createContext(null);
const subscribe=callback=>{window.addEventListener('online',callback);window.addEventListener('offline',callback);return()=>{window.removeEventListener('online',callback);window.removeEventListener('offline',callback);};};
export function ApiProvider({baseUrl='',role,children}) {
  const [session,setSession]=useState(null),[auth,setAuth]=useState({loading:true,demoLogin:false,client:null,error:''});
  const [callbackUrl]=useState(()=>window.location.pathname==='/auth/callback'?window.location.href:null);
  const [callbackPending,setCallbackPending]=useState(!!callbackUrl);
  const online=useSyncExternalStore(subscribe,()=>navigator.onLine,()=>true),base=baseUrl.replace(/\/$/,'');
  // All API calls use the versioned transport (/api/v1); the domain stays shared.
  const request=useCallback(async(path,{method='GET',body=undefined,key=undefined,signal=undefined,token=session?.token}={})=>{
    if(!base) throw new Error('API non configurée.');
    if(!navigator.onLine) throw new Error('Hors ligne. Réessayez après reconnexion.');
    const response=await fetch(base+'/api/v1'+path,{method,signal,cache:'no-store',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let payload;
    try { payload=await response.json(); } catch { throw new Error('Le service est indisponible.'); }
    if(!response.ok){if(response.status===401 && token)setSession(null);throw Object.assign(new Error(payload.error?.message || 'Le service est indisponible.'),{status:response.status,code:payload.error?.code});}
    return payload.data;
  },[base,session?.token]);
  useEffect(()=>{
    let cancelled=false;
    async function initialize(){
      try {
        if(!base)throw new Error();
        const response=await fetch(base+'/api/v1/auth/config',{cache:'no-store'});
        if(!response.ok)throw new Error();
        const {data}=await response.json(),client=oidcClient(base,data.oidc);
        if(cancelled)return;
        setAuth({loading:false,demoLogin:data.demoLogin===true,client,error:''});
        if(callbackUrl){
          if(!client)throw new Error();
          const identity=await finishSignin(client,callbackUrl);
          const me=await fetch(base+'/api/v1/me',{cache:'no-store',headers:{authorization:'Bearer '+identity.access_token}});
          if(!me.ok){await client.manager.removeUser();throw new Error();}
          const {data:user}=await me.json();
          if(!cancelled)setSession({token:identity.access_token,user});
        }
      }catch{
        if(callbackUrl)window.history.replaceState({},'', '/');
        if(!cancelled)setAuth(a=>({...a,loading:false,error:callbackUrl?'Connexion refusée ou expirée. Réessayez.':'Connexion indisponible. Réessayez ultérieurement.'}));
      }finally{if(!cancelled)setCallbackPending(false);}
    }
    initialize();return()=>{cancelled=true;};
  },[base,callbackUrl]);
  useEffect(()=>{
    if(!auth.client)return;
    const expired=()=>{setSession(null);clearSignin(auth.client);setAuth(a=>({...a,error:'Votre session a expiré. Reconnectez-vous.'}));auth.client.manager.removeUser();};
    auth.client.manager.events.addAccessTokenExpired(expired);
    return()=>auth.client.manager.events.removeAccessTokenExpired(expired);
  },[auth.client]);
  const login=useCallback(async()=>{
    if(!auth.client)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    try{await auth.client.manager.clearStaleState();await auth.client.manager.signinRedirect();}
    catch{throw new Error('Impossible de démarrer la connexion. Réessayez.');}
  },[auth.client]);
  const demoLogin=useCallback(async()=>{
    if(!auth.demoLogin)throw new Error('Connexion de développement indisponible.');
    setSession(await request('/auth/demo',{method:'POST',body:{role:Array.isArray(role)?role[0]:role}}));
  },[request,role,auth.demoLogin]);
  const logout=useCallback(async()=>{
    window.dispatchEvent(new Event('leroutier:logout'));
    setSession(null);
    if(auth.client){
      await auth.client.manager.removeUser();
      clearSignin(auth.client);
      // No token hints in logout URLs. Providers supporting client_id may also
      // end SSO; otherwise this securely ends only the local application session.
      try{
        const endpoint=await auth.client.manager.metadataService.getEndSessionEndpoint();
        if(endpoint){const url=new URL(endpoint);url.searchParams.set('client_id',auth.client.manager.settings.client_id);url.searchParams.set('post_logout_redirect_uri',window.location.origin+'/');window.location.assign(url.href);}
      }catch{throw new Error('Session locale fermée. La déconnexion du fournisseur est indisponible.');}
    }
  },[auth.client]);
  const updateProfile=useCallback(async body=>{
    const user=await request('/me',{method:'PATCH',body});setSession(s=>s?{...s,user}:s);
  },[request]);
  // Re-fetch the identity after onboarding/role changes.
  const refresh=useCallback(async()=>{
    const user=await request('/me');setSession(s=>s?{...s,user}:s);
  },[request]);
  const roles=useMemo(()=>Array.isArray(role)?role:[role],[role]);
  const value=useMemo(()=>({request,identity:session?.user,user:session?.user && roles.includes(session.user.role)?session.user:null,role,online,configured:!!base,
    demoLogin:auth.demoLogin,authLoading:auth.loading,authError:auth.error,canSignin:!!auth.client,login,loginDemo:demoLogin,logout,updateProfile,refresh}),[request,session,role,online,base,auth,login,demoLogin,logout,updateProfile,refresh,roles]);
  return <Context.Provider value={value}>{callbackPending?<p role="status">Connexion sécurisée en cours…</p>:children}</Context.Provider>;
}
export function useSession(){return useContext(Context);}
export function useApi(path) {
  const {request,online}=useSession();
  const [version,setVersion]=useState(0),[state,setState]=useState({path:null,request:null,version:0,data:null,error:null,loading:true});
  useEffect(()=>{
    if(!path) return;
    const controller=new AbortController();
    request(path,{signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setState({path,request,version,data,error:null,loading:false});})
      .catch(error=>{if(!controller.signal.aborted)setState({path,request,version,data:null,error:error.message,loading:false});});
    return()=>controller.abort();
  },[path,request,version,online]);
  return {...(state.path===path && state.request===request && state.version===version?state:{data:null,error:null,loading:!!path}),reload:()=>setVersion(v=>v+1)};
}
