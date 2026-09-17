import {useRegisterSW} from 'virtual:pwa-register/react';

export function PwaUpdate() {
  const {needRefresh:[needed,setNeeded],updateServiceWorker}=useRegisterSW();
  if(!needed)return null;
  return <aside role="status" className="card stack" aria-label="Mise à jour de LeRoutier">
    <p>Une nouvelle version est disponible. Terminez votre action avant de recharger.</p>
    <div className="controls"><button className="btn btn-primary" onClick={()=>updateServiceWorker(true)}>Mettre à jour</button>
      <button className="btn btn-soft" onClick={()=>setNeeded(false)}>Plus tard</button></div>
  </aside>;
}
