import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { signInWithGoogle, completeRedirectSignIn, signOutFirebase, idToken, onAuthChange, takeReturnPath,
  safeReturnPath, clearRedirectMarker, createAccountWithEmail, signInWithEmail, sendPasswordReset, changePassword as changePasswordWithFirebase } from './firebase.js';
import { clearQueuedActions } from './offline.js';

// The proof a browser earned by passing the second factor. It is stored like a
// session and not like a credential: it identifies nobody on its own, grants
// nothing without a valid Firebase token sent alongside it, and expires on the
// server. Clearing it costs the user one code, never access to their account.
const TOTP_TOKEN='leroutier:totp';
const readTotp=()=>{try{return window.localStorage.getItem(TOTP_TOKEN)||null;}catch{return null;}};
const writeTotp=value=>{try{value?window.localStorage.setItem(TOTP_TOKEN,value):window.localStorage.removeItem(TOTP_TOKEN);}catch{/* private mode */}};

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
  EMAIL_NOT_VERIFIED:'Confirmez votre adresse e-mail avant de vous connecter.',
  VERIFICATION_UNAVAILABLE:'Impossible d’envoyer l’e-mail de confirmation pour le moment. Réessayez plus tard.',
  // Distinct from the line above on purpose: this one is a fault waiting cannot
  // fix (bad credentials, a spent allowance, a refused address), so it must not
  // invite the retry that the transient wording invites.
  EMAIL_UNAVAILABLE:'L’envoi des e-mails de confirmation est indisponible. Contactez LeRoutier.',
  TOTP_REQUIRED:'Confirmez votre double authentification pour continuer.',
  TOTP_INVALID:'Ce code n’est pas valide. Vérifiez l’heure de votre téléphone.',
  TOTP_REPLAYED:'Ce code a déjà servi. Attendez le suivant.',
  TOTP_ALREADY_ENABLED:'La double authentification est déjà activée sur ce compte.',
  TOTP_NOT_ENABLED:'La double authentification n’est pas activée sur ce compte.',
  TOTP_NOT_STARTED:'Commencez par afficher le code à scanner, puis saisissez un code.',
  DRIVER_ASSIGNED:'Réaffectez le service actif avant de désactiver ce compte.',
  NOT_FOUND:'Introuvable : cet élément n’existe plus.',
  TICKET_INVALID:'Ce billet est invalide, expiré ou remplacé. Demandez au voyageur d’afficher son billet actuel.',
  WRONG_SERVICE:'Ce billet correspond à un autre service. Vérifiez le départ avec le voyageur.',
  WRONG_STOP:'L’embarquement doit se faire à l’arrêt réservé, sur un service démarré.',
  ALREADY_BOARDED:'Ce billet a déjà été utilisé pour embarquer.',
  ACTION_CONFLICT:'Cette action a déjà été enregistrée ou n’est plus possible. Vérifiez le manifeste.',
  ACTIVE_BOOKINGS:'Terminez les débarquements et résolvez les réservations en cours avant de fermer le service.',
  ACTIVE_PARCELS:'Confirmez l’arrivée des colis et résolvez leur prise en charge avant de fermer le service.',
};

export function ApiProvider({baseUrl='',role,children}) {
  // configStatus is deliberately three-valued, because "we could not ask" and
  // "the answer is no" are different facts and only one of them is the
  // deployment's fault. Collapsing them told users the secure sign-in "is not
  // configured yet" during an ordinary outage — an assertion about the
  // deployment that the client was in no position to make.
  const [session,setSession]=useState(null),[auth,setAuth]=useState({loading:true,demoLogin:false,firebase:null,googleAuth:false,error:'',hydrating:false,verifyEmail:null,configStatus:'loading',email:null,emailVerified:false,hasPassword:false,totpRequired:false});
  // Held in a ref rather than state: nothing renders it, and the request that
  // follows a successful code must see it immediately. State would only reach
  // the next render, so that request would go out with the old value and be
  // refused by the very gate it just passed.
  const totpRef=useRef(readTotp());
  const rememberTotp=useCallback(token=>{totpRef.current=token||null;writeTotp(token||null);},[]);
  // Bumped to re-run the config fetch. A retry is the only recovery path this
  // state has: nothing else re-reads it.
  const [configAttempt,setConfigAttempt]=useState(0);
  const retryConfig=useCallback(()=>{setAuth(a=>({...a,configStatus:'loading',error:''}));setConfigAttempt(n=>n+1);},[]);
  const online=useSyncExternalStore(subscribe,()=>navigator.onLine,()=>true),base=baseUrl.replace(/\/$/,'');
  // The config fetch is the one request the whole sign-in surface depends on,
  // and it previously had no recovery path at all: a single transient failure
  // left that tab unable to sign in until the user reloaded by hand. Coming
  // back online is exactly the moment to try again, and only the failed state
  // needs it, so a healthy config is never re-read. Adjusted during render —
  // the repo's convention for state derived from a value just read — because
  // an effect here would be a cascading render for no gain.
  const [prevOnline,setPrevOnline]=useState(online);
  if(prevOnline!==online){
    setPrevOnline(online);
    if(online && auth.configStatus==='failed') retryConfig();
  }
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
    const response=await fetch(base+'/api/v1'+path,{method,signal,cache:'no-store',headers:{'content-type':'application/json','x-request-id':crypto.randomUUID(),...(bearer?{authorization:'Bearer '+bearer}:{}),...(key?{'idempotency-key':key}:{}),...(totpRef.current?{'x-totp':totpRef.current}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let payload;
    try { payload=await response.json(); } catch { throw new Error('Le service est indisponible.'); }
    if(!response.ok){
      if(response.status===401 && bearer)setSession(null);
      const code=payload.error?.code;
      // Any endpoint can raise this, not just /me: a browser whose proof
      // expired hits it on whatever call it happens to make next. Surfacing it
      // from the one place every call goes through means the panel appears
      // wherever the user is, instead of only at sign-in.
      if(code==='TOTP_REQUIRED')setAuth(a=>a.totpRequired?a:{...a,totpRequired:true,error:''});
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
  // Profile fields captured at registration, applied the moment the verified
  // account first establishes its session — the name and phone typed at sign-up
  // survive the verification round trip instead of being asked twice.
  const pendingProfileRef=useRef(null);
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
      if(pendingProfileRef.current){
        const pending=pendingProfileRef.current;
        pendingProfileRef.current=null;
        try{
          const updated=await request('/me',{method:'PATCH',body:pending});
          setSession(s=>s?{...s,user:updated}:s);
        }catch{ /* profile completion remains available through ProfileForm */ }
      }
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
        // Bounded like /me: a hung proxy must not leave the sign-in entry
        // saying "Connexion en cours…" indefinitely. The payload is four
        // public identifiers, so this is generous rather than tight.
        const response=await fetch(base+'/api/v1/auth/config',{cache:'no-store',signal:AbortSignal.timeout(15_000)});
        if(!response.ok)throw new Error();
        const {data}=await response.json();
        if(cancelled)return;
        // The provider list is the one source of truth for what sign-in offers.
        // A provider not listed is not rendered — and when the API says nothing
        // about providers (an older API, a fixture), fail hidden.
        const googleAuth=Array.isArray(data.firebase?.providers) && data.firebase.providers.includes('google');
        // A merge, not a replacement: the auth-state listener owns email and
        // emailVerified, and a retry of this fetch must not blank them.
        setAuth(a=>({...a,loading:false,demoLogin:data.demoLogin===true,firebase:data.firebase ?? null,googleAuth,error:'',hydrating:false,verifyEmail:null,
          // The API answered. If it answered without a firebase block, sign-in
          // genuinely is not configured here — that is the only case that may
          // say so.
          configStatus:data.firebase?'ready':'unconfigured'}));

        if(!googleAuth){
          // The provider is disabled: a redirect attempt that started under an
          // earlier configuration can no longer complete, and its "retry
          // Google" error would describe a method the UI no longer offers.
          // Drop the marker silently — the credential, if any, expired with it.
          clearRedirectMarker();
        }else if(data.firebase){
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
        // We never learned what the deployment offers. Record the failure as
        // its own state rather than as an empty answer, so the UI can offer a
        // retry instead of asserting something it does not know.
        if(!cancelled)setAuth(a=>({...a,loading:false,configStatus:'failed',error:'Connexion indisponible. Réessayez ultérieurement.'}));
      }
    })();
    return()=>{cancelled=true;};
  },[base,configAttempt]);

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
        // The account page shows the address and its verified state, and the
        // password change needs the address to re-authenticate with. LeRoutier
        // deliberately keeps no email of its own (users has no such column),
        // so the provider's own user is the single source. Identity-stable, so
        // a token refresh that changes nothing causes no re-render.
        const nextEmail=firebaseUser?.email??null,nextVerified=firebaseUser?.emailVerified===true;
        // Whether a password EXISTS on this identity — which is what decides if
        // the account page may offer to change one. A Google identity has none,
        // and offering the form would be offering something that cannot work.
        const nextHasPassword=(firebaseUser?.providerData??[]).some(entry=>entry?.providerId==='password');
        setAuth(a=>a.email===nextEmail&&a.emailVerified===nextVerified&&a.hasPassword===nextHasPassword
          ?a:{...a,email:nextEmail,emailVerified:nextVerified,hasPassword:nextHasPassword});
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
          if(error?.code==='EMAIL_NOT_VERIFIED'){
            // Firebase authenticated them, LeRoutier refused to establish a
            // session: sign the provider session back out and show the
            // "confirm your email" panel with a resend. Never a half state.
            const unverifiedEmail=firebaseUserRef.current?.email;
            await signOutFirebase(auth.firebase).catch(()=>{});
            if(cancelled)return;
            setSession(null);
            setAuth(a=>({...a,hydrating:false,error:'',
              verifyEmail:a.verifyEmail ?? {email:unverifiedEmail?String(unverifiedEmail):'',kind:'login'}}));
            return;
          }
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
    setAuth(a=>({...a,error:'',totpRequired:false}));
    try{ clearQueuedActions(window.localStorage); }catch{ /* private mode */ }
    if(auth.firebase)await signOutFirebase(auth.firebase);
  },[auth.firebase]);

  const updateProfile=useCallback(async body=>{
    const user=await request('/me',{method:'PATCH',body});setSession(s=>s?{...s,user}:s);
  },[request]);

  // The verification email endpoint takes the Firebase ID token itself — the
  // address in the message always comes from the verified token's claims,
  // never from whatever a caller might put in a body.
  const requestVerificationEmail=useCallback(async()=>{
    const result=await request('/auth/email-verification',{method:'POST'});
    return result?.status ?? 'sent';
  },[request]);

  const createAccount=useCallback(async({email,password,displayName,phone})=>{
    if(!auth.firebase)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    const result=await createAccountWithEmail(auth.firebase,{email,password});
    if(!result?.user)throw new Error('La création du compte a échoué. Réessayez.');
    // A new password account is NOT a LeRoutier identity yet — /me refuses it
    // until the address is confirmed. Send the verification link while the
    // fresh Firebase session still exists, remember the profile fields for the
    // first verified sign-in, then sign out cleanly. A failed send is not a
    // failed account: the panel below offers a resend.
    pendingProfileRef.current={displayName:String(displayName||'').trim()||String(email).trim().split('@')[0],phone:String(phone||'').trim()||null};
    let sendFailed=null;
    try{ await requestVerificationEmail(); }catch(error){ sendFailed=error.message; }
    await signOutFirebase(auth.firebase).catch(()=>{});
    setSession(null);
    setAuth(a=>({...a,error:'',hydrating:false,verifyEmail:{email:String(email).trim(),kind:'created',sendFailed}}));
    return result.user;
  },[auth.firebase,requestVerificationEmail]);

  const loginEmail=useCallback(async({email,password})=>{
    if(!auth.firebase)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    await signInWithEmail(auth.firebase,{email,password});
    // An unverified account throws EMAIL_NOT_VERIFIED from /me; the auth-state
    // listener turns that into the "confirm your email" panel with a resend.
    await establishSession();
  },[auth.firebase,establishSession]);

  const resetPassword=useCallback(async email=>{
    if(!auth.firebase)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    try{ await sendPasswordReset(auth.firebase,email); return 'Si cette adresse possède un compte, un e-mail de réinitialisation a été envoyé.'; }
    catch{ throw new Error('Impossible d’envoyer le lien de réinitialisation. Réessayez.'); }
  },[auth.firebase]);

  // Changing the password re-authenticates with the current one first; see
  // changePassword in firebase.js for why that ordering is the safe one.
  const changePassword=useCallback(async({currentPassword,newPassword})=>{
    if(!auth.firebase)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    if(!auth.email)throw new Error('Aucune adresse e-mail associée à ce compte.');
    await changePasswordWithFirebase(auth.firebase,{email:auth.email,currentPassword,newPassword});
  },[auth.firebase,auth.email]);

  // Passing the second factor. A correct code (or recovery code) returns a
  // proof this browser keeps, so the question is asked once per device rather
  // than once per visit — and the session is then established afresh, because
  // the attempt that raised the challenge already failed.
  const submitTotp=useCallback(async code=>{
    const result=await request('/auth/totp',{method:'POST',body:{code}});
    rememberTotp(result.token);
    setAuth(a=>({...a,totpRequired:false,error:''}));
    return result;
  },[request,rememberTotp]);

  const forgetTotp=useCallback(()=>rememberTotp(null),[rememberTotp]);

  // Resend from the "confirm your email" panel. The provider session was
  // signed out cleanly, so the resend re-authenticates with the password —
  // that is what proves the caller owns the account — then signs back out.
  const resendVerification=useCallback(async({email,password})=>{
    if(!auth.firebase)throw new Error('La connexion sécurisée n’est pas encore configurée.');
    await signInWithEmail(auth.firebase,{email,password});
    try{
      return await requestVerificationEmail();
    }finally{
      await signOutFirebase(auth.firebase).catch(()=>{});
    }
  },[auth.firebase,requestVerificationEmail]);

  const backToSignin=useCallback(()=>{
    setSession(null);
    setAuth(a=>({...a,verifyEmail:null,error:'',totpRequired:false}));
  },[]);

  const refresh=useCallback(async()=>{
    const user=await request('/me');setSession(s=>s?{...s,user}:s);
  },[request]);

  const roles=useMemo(()=>Array.isArray(role)?role:[role],[role]);
  const value=useMemo(()=>({request,identity:session?.user,user:session?.user && roles.includes(session.user.role)?session.user:null,role,online,configured:!!base,
    // Hydrating (a redirect just delivered its user and /me is in flight) is
    // loading too: the login UI must not offer a second attempt mid-hydration.
    demoLogin:auth.demoLogin,authLoading:auth.loading||auth.hydrating,authError:auth.error,canSignin:!!auth.firebase,
    // 'loading' | 'ready' | 'unconfigured' | 'failed'. Only 'unconfigured' may
    // claim the deployment has no secure sign-in; 'failed' means we could not
    // ask, and is the one the user can act on.
    configStatus:auth.configStatus,retryConfig,
    // The provider's own view of the signed-in address. Read-only by design:
    // LeRoutier stores no email of its own, so there is nothing here to edit.
    email:auth.email,emailVerified:auth.emailVerified,hasPassword:auth.hasPassword,
    // The published Firebase web config, for the verify-email route to apply
    // the oobCode through the same SDK instance. Public identifiers only.
    firebase:auth.firebase,
    verifyEmail:auth.verifyEmail,resendVerification,backToSignin,
    googleAuth:auth.googleAuth,login,loginDemo:demoLogin,logout,updateProfile,refresh,
    createAccount,loginEmail,resetPassword,changePassword,
    totpRequired:auth.totpRequired,submitTotp,forgetTotp,retrySession:establishSession}),
  [request,session,role,online,base,auth,login,demoLogin,logout,updateProfile,refresh,roles,createAccount,loginEmail,resetPassword,resendVerification,backToSignin,retryConfig,changePassword,submitTotp,forgetTotp,establishSession]);
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
