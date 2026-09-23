import {useEffect} from 'react';
import {useRegisterSW} from 'virtual:pwa-register/react';

export function PwaUpdate() {
  const {needRefresh:[needed,setNeeded],updateServiceWorker}=useRegisterSW();
  // The registration already checks for a new service worker on launch. An
  // installed PWA can then sit open for days, so check again when it returns
  // to the foreground and when the network comes back — discovery only: the
  // update itself stays prompt-based below, and never reloads mid-action.
  useEffect(()=>{
    const check=()=>{ navigator.serviceWorker?.ready.then(reg=>reg.update().catch(()=>{})).catch(()=>{}); };
    const onVisible=()=>{ if(document.visibilityState==='visible') check(); };
    window.addEventListener('visibilitychange',onVisible);
    window.addEventListener('online',check);
    return()=>{ window.removeEventListener('visibilitychange',onVisible); window.removeEventListener('online',check); };
  },[]);
  if(!needed)return null;
  return <aside role="status" className="card stack" aria-label="Mise à jour de LeRoutier">
    <p>Une nouvelle version est disponible. Terminez votre action avant de recharger.</p>
    <div className="controls"><button className="btn btn-primary" onClick={()=>updateServiceWorker(true)}>Mettre à jour</button>
      <button className="btn btn-soft" onClick={()=>setNeeded(false)}>Plus tard</button></div>
  </aside>;
}
