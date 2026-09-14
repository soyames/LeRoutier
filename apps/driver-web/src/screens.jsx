import { useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, StatCard, SectionTitle, ApiState } from '@leroutier/ui';
import { Users, Route, BusFront, QrCode, AlertTriangle } from 'lucide-react';

export function RouteScreen(){
  const {user,request,online}=useSession(),service=useApi(user?'/driver/service':null);
  const s=service.data,manifest=useApi(s?`/services/${s.id}/manifest`:null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[description,setDescription]=useState(''),[notice,setNotice]=useState('');
  async function act(path,body){setBusy(true);setError('');setNotice('');try{await request(path,{method:'POST',body});manifest.reload();service.reload();setNotice('Action enregistrée.');return true;}catch(e){setError(e.message);return false;}finally{setBusy(false);}}
  if(!user || service.loading || service.error || !s) return <><SectionTitle title="Feuille de route & embarquement"/><ApiState resource={service} empty={user?'Aucun service affecté.':'Connectez-vous pour voir votre affectation.'}/></>;
  const stop=s.stops.find(stop=>stop.sequence===s.current_sequence);
  return <>
    <Card className="card-dark stack"><div className="between wrap"><div><span className="eyebrow">{s.status}</span><h2>{s.route_name}</h2></div><Badge>{s.registration}</Badge></div><strong>Arrêt courant : {stop?.city}</strong></Card>
    <div className="grid grid-3"><StatCard label="À bord" value={manifest.data?.filter(b=>b.status==='boarded').length || 0} icon={Users} tone="success"/><StatCard label="Places véhicule" value={s.capacity} icon={BusFront}/><StatCard label="Arrêt" value={s.current_sequence+1} icon={Route}/></div>
    <Card className="scanner"><SectionTitle icon={QrCode} title="Contrôle des billets"/><p className="small">Vérifiez la référence du billet puis pointez le passager dans le manifeste. La lecture caméra et la validation hors ligne ne sont pas encore disponibles.</p></Card>
    <SectionTitle icon={Users} title="Manifeste passagers" trailing={<Badge>{stop?.city}</Badge>}/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {manifest.loading || manifest.error || !manifest.data?.length ? <ApiState resource={manifest} empty="Aucun passager confirmé."/> : manifest.data.map(b=><div className="manifest-row" key={b.id}><div className="seat"><small>Siège</small><strong>{b.seat_number}</strong></div><div><h3>{b.passenger_name}</h3><span className="small muted">{b.id}</span><div><Badge tone={b.status==='boarded'?'success':'neutral'}>{b.status}</Badge></div></div>
      {b.status==='confirmed' && b.origin_sequence===s.current_sequence && <button className="btn btn-primary" disabled={busy || !online} onClick={()=>act(`/bookings/${b.id}/board`,{stopSequence:s.current_sequence})}>Embarquer</button>}
      {b.status==='boarded' && b.destination_sequence===s.current_sequence && <button className="btn btn-soft" disabled={busy || !online} onClick={()=>act(`/bookings/${b.id}/alight`,{stopSequence:s.current_sequence})}>Débarquer</button>}
    </div>)}
    <Card className="stack"><span className="eyebrow">Actions terrain</span>{s.current_sequence<s.stops.length-1 && <button className="btn btn-primary" disabled={busy || !online} onClick={()=>act(`/services/${s.id}/advance`,{sequence:s.current_sequence+1})}>Arrivée à l’arrêt suivant</button>}
      <button className="btn btn-soft" disabled={busy || !online} onClick={()=>navigator.geolocation? navigator.geolocation.getCurrentPosition(p=>act(`/services/${s.id}/positions`,{latitude:p.coords.latitude,longitude:p.coords.longitude,observedAt:new Date(p.timestamp).toISOString()}),()=>setError('Position indisponible ou autorisation refusée.')):setError('Géolocalisation indisponible.')}>Partager ma position</button>
    </Card>
    <Card className="stack"><SectionTitle icon={AlertTriangle} title="Signaler un incident"/><form className="stack" onSubmit={async e=>{e.preventDefault();if(await act('/incidents',{serviceId:s.id,kind:'other',severity:'medium',description}))setDescription('');}}><label>Description<textarea className="control" value={description} onChange={e=>setDescription(e.target.value)} maxLength={2000} required/></label><button className="btn btn-danger" disabled={busy || !online || !description.trim()}>Enregistrer l’incident</button></form></Card>
  </>;
}
export function Profile(){
  const {user}=useSession(),service=useApi(user?'/driver/service':null);
  return <><Card className="stack"><h2>{user?.display_name || 'Profil conducteur'}</h2><span className="small muted">Compte conducteur</span></Card><Card className="stack"><SectionTitle icon={BusFront} title="Affectation véhicule"/>{service.data?<><h3>{service.data.registration}</h3><p>{service.data.route_name}</p><Badge>{service.data.capacity} places</Badge></>:<ApiState resource={service} empty="Aucune affectation disponible."/>}</Card></>;
}
