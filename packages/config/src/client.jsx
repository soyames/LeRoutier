import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { signInWithGoogle, completeRedirectSignIn, signOutFirebase, idToken, onAuthChange, takeReturnPath,
  safeReturnPath, createAccountWithEmail, signInWithEmail, sendPasswordReset } from './firebase.js';
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
  const [session,setSession]=useState(null),[auth,setAuth]=useState({loading:true,demoLogin:false,firebase:null,error:'',hydrating:false});
  const online=useSyncExternalStore(subscribe,()=>navigator.onLine,()=>true),base=baseUrl.replace(/\/$/,'');
  // Hoisted so the memoization dependency is exactly the value read: the
  // session object changes on every /me refresh, but session.token is only set
  // by demo login — depending on it keeps `request` (and the auth-change
  // subscription) stable across refreshes instead of re-subscribing each time.
  const sessionToken=session?.token;
  const authorization=useCallback(async explicit=>{
    if(explicit)return explicit;
    if(sessionToken)return sessionToken;
    return auth.firebase?await idToken(auth.firebase).catch(()=>null):null;
  },[sessionToken,auth.firebase]);

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

  // Provider authentication is only half of sign-in. There is exactly ONE
  // session-establishment path — /me after Firebase has an authenticated user
  // — and every caller either joins the in-flight request or, once the session
  // for that Firebase identity already exists, gets it back with no network
  // at all. The SDK fires onAuthStateChanged again when it refreshes the user
  // instance, and a sign-in action resolves slightly after the listener runs:
  // both would otherwise re-run /me sequentially, which the gate alone cannot
  // absorb. The 30s bound keeps the "Connexion en cours…" state honest: it
  // can never outlive the attempt it describes.
  const gateRef=useRef(null);
  const sessionRef=useRef(null);
  const firebaseUserRef=useRef(null);
  const hydratedUidRef=useRef(null);
  useEffect(()=>{ sessionRef.current=session; },[session]);
  const establishSession=useCallback(async()=>{
    const uid=firebaseUserRef.current?.uid ?? null;
    if (hydratedUidRef.current !== null && hydratedUidRef.current === uid && sessionRef.current?.user) {
      return sessionRef.current.user;
    }
    if(gateRef.current)return gateRef.current;
    /** @type {{resolve?: (value?: any)=>void, reject?: (reason?: any)=>void}} */
    const gate={};
    const promise=new Promise((res,rej)=>{gate.resolve=res;gate.reject=rej;});
    gateRef.current=promise;
    try{
      const user=await request('/me',{signal:AbortSignal.timeout(30_000)});
      setSession({token:null,user});
      setAuth(a=>({...a,error:'',hydrating:false}));
      hydratedUidRef.current=uid;
      gate.resolve?.(user);
      return user;
    }catch(error){
      gate.reject?.(error);
      throw error;
    }finally{
      gateRef.current=null;
    }
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
        setAuth({loading:false,demoLogin:data.demoLogin===true,firebase:data.firebase ?? null,error:'',hydrating:false});

        if(data.firebase){
          const outcome=await completeRedirectSignIn(data.firebase).catch(error=>({user:null,error,returnTo:null}));
          if(outcome && !cancelled){
            if(outcome.user){
              // Firebase has the user (fresh credential or restored session).
              // Clean the URL here — /me must NOT run from this stale render,
              // whose authorization callback still sees auth.firebase=null.
              // The auth-state listener below runs after the state commit and
              // establishes the LeRoutier session with a real token; until it
              // lands, keep the UI on "Connexion en cours…" (hydrating).
              const destination=outcome.returnTo ? safeReturnPath(outcome.returnTo) : takeReturnPath();
              window.history.replaceState({},'',destination);
              setAuth(a=>({...a,hydrating:true}));
            }else{
              setAuth(a=>({...a,error:outcome.error?.message ?? 'La connexion a échoué. Réessayez.'}));
            }
          }
        }
      }catch{
        if(!cancelled)setAuth(a=>({...a,loading:false,error:'Connexion indisponible. Réessayez ultérieurement.'}));
      }
    })();
    return()=>{cancelled=true;};
  },[base]);

  // One session-establishment path. onAuthStateChanged is the only thing that
  // calls /me: popup, password and redirect completion all converge on it, and
  // every other caller joins its in-flight request through the gate.
  useEffect(()=>{
    if(!auth.firebase)return;
    let cancelled=false,unsubscribe=()=>{};
    (async()=>{
      unsubscribe=await onAuthChange(auth.firebase,async firebaseUser=>{
        if(cancelled)return;
        firebaseUserRef.current=firebaseUser;
        if(!firebaseUser){
          gateRef.current=null;
          hydratedUidRef.current=null;
          setSession(s=>(s?.token?s:null));
          setAuth(a=>({...a,hydrating:false}));
          return;
        }
        try{
          await establishSession();
        }catch(error){
          if(cancelled)return;
          if(error?.code==='REGISTRATION_SUSPENDED')await signOutFirebase(auth.firebase).catch(()=>{});
          if(cancelled)return;
          setSession(null);
          const message=error?.name==='TimeoutError'
            ? 'Le service met trop de temps à répondre. Réessayez.'
            : error?.message ?? 'Impossible de charger votre compte.';
          setAuth(a=>({...a,hydrating:false,error:message}));
        }
      });
    })();
    return()=>{cancelled=true;unsubscribe();};
  },[auth.firebase,establishSession]);

  // A launch or a sign-in that happened offline fails /me and leaves the
  // Firebase user present with no LeRoutier session. When the network comes
  // back, re-establish through the same single path instead of staying
  // signed out visually until some later event happens to fire.
  useEffect(()=>{
    if(!online||!auth.firebase||session)return;
    if(!firebaseUserRef.current)return;
    establishSession().catch(()=>{});
  },[online,auth.firebase,session,establishSession]);

  const login=useCallback(async()=>{
    if(!auth.firebase)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    const firebaseUser=await signInWithGoogle(auth.firebase,window.location.pathname+window.location.search);
    // Redirect flow: the page leaves for the provider, and the return reloads
    // the app — the auth-state listener establishes the session. Popup flow:
    // the user is already here, so join the listener's in-flight /me and stay
    // on the button's progress state until the session actually exists.
    if(firebaseUser)await establishSession();
  },[auth.firebase,establishSession]);

  const demoLogin=useCallback(async(as=undefined)=>{
    if(!auth.demoLogin)throw new Error('Connexion de développement indisponible.');
    setSession(await request('/auth/demo',{method:'POST',body:typeof as==='object'?as:{role:as ?? (Array.isArray(role)?role[0]:role)}}));
  },[request,role,auth.demoLogin]);

  const logout=useCallback(async()=>{
    // Clear eagerly: between the state update and the provider's auth-state
    // callback there is a window where a reconnect effect could otherwise see
    // the old Firebase user and re-establish the session it was told to end.
    firebaseUserRef.current=null;
    hydratedUidRef.current=null;
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
    // Hydrating (a redirect just delivered its user and /me is in flight) is
    // loading too: the login UI must not offer a second attempt mid-hydration.
    demoLogin:auth.demoLogin,authLoading:auth.loading||auth.hydrating,authError:auth.error,canSignin:!!auth.firebase,login,loginDemo:demoLogin,logout,updateProfile,refresh,
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
