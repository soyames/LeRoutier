import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

const Context=createContext(null);
const subscribe=callback=>{window.addEventListener('online',callback);window.addEventListener('offline',callback);return()=>{window.removeEventListener('online',callback);window.removeEventListener('offline',callback);};};
export function ApiProvider({baseUrl='',role,children}) {
  const [session,setSession]=useState(null),[demoLogin,setDemoLogin]=useState(false);
  const online=useSyncExternalStore(subscribe,()=>navigator.onLine,()=>true);
  const base=baseUrl.replace(/\/$/,'');
  const request=useCallback(async(path,{method='GET',body=undefined,key=undefined,signal=undefined,token=session?.token}={})=>{
    if(!base) throw new Error('API non configurée.');
    if(!navigator.onLine) throw new Error('Hors ligne. Réessayez après reconnexion.');
    const response=await fetch(base+path,{method,signal,cache:'no-store',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let payload;
    try { payload=await response.json(); } catch { throw new Error('Le service est indisponible.'); }
    if(!response.ok) throw new Error(payload.error?.message || 'Le service est indisponible.');
    return payload.data;
  },[base,session?.token]);
  useEffect(()=>{
    const controller=new AbortController();
    if(base) fetch(base+'/auth/config',{signal:controller.signal}).then(r=>r.json()).then(r=>setDemoLogin(r.data?.demoLogin===true)).catch(()=>{});
    return()=>controller.abort();
  },[base]);
  const login=useCallback(async(token=undefined)=>{
    if(token) {
      const user=await request('/me',{token});
      if(user.role!==role) throw new Error('Ce compte ne correspond pas à cette application.');
      setSession({token,user});
    } else {
      const next=await request('/auth/demo',{method:'POST',body:{role}});setSession(next);
    }
  },[request,role]);
  const value=useMemo(()=>({request,user:session?.user,online,configured:!!base,demoLogin,login,logout:()=>setSession(null)}),[request,session,online,base,demoLogin,login]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSession(){return useContext(Context);}
export function useApi(path) {
  const {request,online}=useSession();
  const [version,setVersion]=useState(0),[state,setState]=useState({path:null,data:null,error:null,loading:true});
  useEffect(()=>{
    if(!path) return;
    const controller=new AbortController();
    request(path,{signal:controller.signal}).then(data=>setState({path,data,error:null,loading:false}))
      .catch(error=>{if(!controller.signal.aborted)setState({path,data:null,error:error.message,loading:false});});
    return()=>controller.abort();
  },[path,request,version,online]);
  return {...(state.path===path?state:{data:null,error:null,loading:!!path}),reload:()=>setVersion(v=>v+1)};
}
