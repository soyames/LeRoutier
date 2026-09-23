import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { signInWithGoogle, completeRedirectSignIn, signOutFirebase, idToken, onAuthChange, takeReturnPath,
  createAccountWithEmail, signInWithEmail, sendPasswordReset } from './firebase.js';
import { clearQueuedActions } from './offline.js';

const Context=createContext(null);
const subscribe=callback=>{window.addEventListener('online',callback);window.addEventListener('offline',callback);return()=>{window.removeEventListener('online',callback);window.removeEventListener('offline',callback);};};

const ERROR_COPY={
  UNAUTHORIZED:'Connectez-vous pour continuer.',
  AUTH_UNAVAILABLE:'La connexion sécurisée n’est pas disponible pour le moment. Réessayez plus tard.',
  ACCOUNT_DISABLED:'Ce compte est désactivé. Contactez votre exploitation ou LeRoutier.',
  REGISTRATION_SUSPENDED:'Les inscriptions LeRoutier sont momentanément suspendues. Les comptes existants fonctionnent normalement ; réessayez plus tard.',
  PROFILE_REQUIRED:'Complétez votre profil avant de réserver.',
  RATE_LIMITED:'Trop de tentatives. Patientez un instant avant de réessayer.',
  FORBIDDEN:'Vous n’avez pas accès à cette action avec ce compte.',
  TICKET_INVALID:'Ce billet est invalide, expiré ou remplacé. Demandez au voyageur d’afficher son billet actuel.',
  WRONG_SERVICE:'Ce billet correspond à un autre service. Vérifiez le départ avec le voyageur.',
  WRONG_STOP:'L’embarquement doit se faire à l’arrêt réservé, sur un service démarré.',
  ALREADY_BOARDED:'Ce billet a déjà été utilisé pour embarquer.',
  ACTION_CONFLICT:'Cette action a déjà été enregistrée ou n’est plus possible. Vérifiez le manifeste.',
  ACTIVE_BOOKINGS:'Terminez les débarquements et résolvez les réservations en cours avant de fermer le service.',
  ACTIVE_PARCELS:'Confirmez l’arrivée des colis et résolvez leur prise en charge avant de fermer le service.',
};

export function ApiProvider({baseUrl='',role,children}) {
  const [session,setSession]=useState(null),[auth,setAuth]=useState({loading:true,demoLogin:false,firebase:null,error:''});
  const online=useSyncExternalStore(subscribe,()=>navigator.onLine,()=>true),base=baseUrl.replace(/\/$/,'');

  const authorization=useCallback(async explicit=>{
    if(explicit)return explicit;
    if(session?.token)return session.token;
    return auth.firebase?await idToken(auth.firebase).catch(()=>null):null;
  },[session?.token,auth.firebase]);

  const request=useCallback(async(path,{method='GET',body=undefined,key=undefined,signal=undefined,token=undefined}={})=>{
    if(!base) throw new Error('API non configurée.');
    if(!navigator.onLine) throw new Error('Hors ligne. Réessayez après reconnexion.');
    const bearer=await authorization(token);
    const response=await fetch(base+'/api/v1'+path,{method,signal,cache:'no-store',headers:{'content-type':'application/json','x-request-id':crypto.randomUUID(),...(bearer?{authorization:'Bearer '+bearer}:{}),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let payload;
    try { payload=await response.json(); } catch { throw new Error('Le service est indisponible.'); }
    if(!response.ok){
      if(response.status===401 && bearer)setSession(null);
      const code=payload.error?.code;
      throw Object.assign(new Error(ERROR_COPY[code] || payload.error?.message || 'Le service est indisponible.'),
        {status:response.status,code});
    }
    return payload.data;
  },[base,authorization]);

  // Provider authentication is only half of sign-in. Keep popup/password login
  // pending until LeRoutier has resolved the Firebase identity through /me and
  // the workspace actually has a session to render.
  const establishSession=useCallback(async()=>{
    const user=await request('/me');
    setSession({token:null,user});
    return user;
  },[request]);

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        if(!base)throw new Error();
        const response=await fetch(base+'/api/v1/auth/config',{cache:'no-store'});
        if(!response.ok)throw new Error();
        const {data}=await response.json();
        if(cancelled)return;
        setAuth({loading:false,demoLogin:data.demoLogin===true,firebase:data.firebase ?? null,error:''});

        if(data.firebase){
          const outcome=await completeRedirectSignIn(data.firebase).catch(error=>({user:null,error}));
          if(outcome && !cancelled){
            const destination=takeReturnPath();
            // A redirect completes during the same effect that first publishes
            // Firebase config. Do not call /me from this stale render: the
            // authorization callback still sees auth.firebase=null. Clean the
            // URL here; the auth-state listener below runs after the state
            // commit and establishes the LeRoutier session with a real token.
            if(outcome.user)window.history.replaceState({},'',destination);
            else setAuth(a=>({...a,error:outcome.error?.message ?? 'La connexion a échoué. Réessayez.'}));
          }
        }
      }catch{
        if(!cancelled)setAuth(a=>({...a,loading:false,error:'Connexion indisponible. Réessayez ultérieurement.'}));
      }
    })();
    return()=>{cancelled=true;};
  },[base]);

  useEffect(()=>{
    if(!auth.firebase)return;
    let cancelled=false,unsubscribe=()=>{};
    (async()=>{
      unsubscribe=await onAuthChange(auth.firebase,async firebaseUser=>{
        if(cancelled)return;
        if(!firebaseUser){setSession(s=>(s?.token?s:null));return;}
        try{
          const user=await request('/me');
          if(!cancelled)setSession({token:null,user});
        }catch(error){
          if(!cancelled){setSession(null);setAuth(a=>({...a,error:error.message}));}
          if(error?.code==='REGISTRATION_SUSPENDED')await signOutFirebase(auth.firebase).catch(()=>{});
        }
      });
    })();
    return()=>{cancelled=true;unsubscribe();};
  },[auth.firebase,request]);

  const login=useCallback(async()=>{
    if(!auth.firebase)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    const firebaseUser=await signInWithGoogle(auth.firebase,window.location.pathname+window.location.search);
    if(firebaseUser)await establishSession();
  },[auth.firebase,establishSession]);

  const demoLogin=useCallback(async(as=undefined)=>{
    if(!auth.demoLogin)throw new Error('Connexion de développement indisponible.');
    setSession(await request('/auth/demo',{method:'POST',body:typeof as==='object'?as:{role:as ?? (Array.isArray(role)?role[0]:role)}}));
  },[request,role,auth.demoLogin]);

  const logout=useCallback(async()=>{
    setSession(null);
    setAuth(a=>({...a,error:''}));
    try{ clearQueuedActions(window.localStorage); }catch{ /* private mode */ }
    if(auth.firebase)await signOutFirebase(auth.firebase);
  },[auth.firebase]);

  const updateProfile=useCallback(async body=>{
    const user=await request('/me',{method:'PATCH',body});setSession(s=>s?{...s,user}:s);
  },[request]);

  const createAccount=useCallback(async({email,password,displayName,phone})=>{
    if(!auth.firebase)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    const result=await createAccountWithEmail(auth.firebase,{email,password});
    if(!result?.user)throw new Error('La création du compte a échoué. Réessayez.');
    await establishSession();
    try{ await updateProfile({displayName:String(displayName||'').trim()||email.split('@')[0],phone:String(phone||'').trim()||null}); }catch{ /* profile completion remains available */ }
    return result.user;
  },[auth.firebase,establishSession,updateProfile]);

  const loginEmail=useCallback(async({email,password})=>{
    if(!auth.firebase)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    await signInWithEmail(auth.firebase,{email,password});
    await establishSession();
  },[auth.firebase,establishSession]);

  const resetPassword=useCallback(async email=>{
    if(!auth.firebase)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    try{ await sendPasswordReset(auth.firebase,email); return 'Si cette adresse possède un compte, un e-mail de réinitialisation a été envoyé.'; }
    catch{ throw new Error('Impossible d’envoyer le lien de réinitialisation. Réessayez.'); }
  },[auth.firebase]);

  const refresh=useCallback(async()=>{
    const user=await request('/me');setSession(s=>s?{...s,user}:s);
  },[request]);

  const roles=useMemo(()=>Array.isArray(role)?role:[role],[role]);
  const value=useMemo(()=>({request,identity:session?.user,user:session?.user && roles.includes(session.user.role)?session.user:null,role,online,configured:!!base,
    demoLogin:auth.demoLogin,authLoading:auth.loading,authError:auth.error,canSignin:!!auth.firebase,login,loginDemo:demoLogin,logout,updateProfile,refresh,
    createAccount,loginEmail,resetPassword}),
  [request,session,role,online,base,auth,login,demoLogin,logout,updateProfile,refresh,roles,createAccount,loginEmail,resetPassword]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(){return useContext(Context);}

export function useApi(path) {
  const {request,online}=useSession();
  const [version,setVersion]=useState(0),[state,setState]=useState({path:null,request:null,version:0,data:null,error:null,code:null,loading:true});
  useEffect(()=>{
    if(!path) return;
    if(!online) return;
    const controller=new AbortController();
    request(path,{signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setState({path,request,version,data,error:null,code:null,loading:false});})
      .catch(error=>{if(!controller.signal.aborted)setState({path,request,version,data:null,error:error.message,code:error.code ?? null,loading:false});});
    return()=>controller.abort();
  },[path,request,version,online]);
  const cached=state.path===path && state.request===request?state.data:null;
  const offline={data:cached,error:cached?null:'Hors ligne. Réessayez après reconnexion.',code:null,loading:false};
  return {...(!online?offline:state.path===path && state.request===request && state.version===version?state:{data:null,error:null,code:null,loading:!!path}),reload:()=>setVersion(v=>v+1)};
}

export const IDENTITY_ERROR_CODES=['ACCOUNT_DISABLED','FORBIDDEN','UNAUTHORIZED','AUTH_UNAVAILABLE','PROFILE_REQUIRED'];
