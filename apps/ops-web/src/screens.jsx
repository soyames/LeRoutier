import { useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, StatCard, SectionTitle, ApiState } from '@leroutier/ui';
import { BusFront, Armchair, Radio, ShieldAlert, WalletCards } from 'lucide-react';

export function Dashboard(){
  const {user,request,online}=useSession(),fleet=useApi(user?'/ops/fleet':null),incidents=useApi(user?'/incidents':null),bookings=useApi(user?'/ops/bookings':null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[reference,setReference]=useState(''),[notice,setNotice]=useState('');
  async function act(path,body,method='POST',key=undefined){setBusy(true);setError('');setNotice('');try{await request(path,{method,body,key});fleet.reload();incidents.reload();bookings.reload();setNotice('Action enregistrée.');}catch(e){setError(e.message);}finally{setBusy(false);}}
  const services=fleet.data?.services || [],vehicles=fleet.data?.vehicles || [];
  return <>
    <Card className="hero stack"><span className="eyebrow">Corridor RNIE 2</span><h1>Supervision Cotonou → Bohicon → Dassa → Parakou</h1><p>Flotte, capacité par segment, incidents et reprise depuis le service partagé LeRoutier.</p></Card>
    {!user || fleet.loading || fleet.error ? <ApiState resource={fleet} empty="Connectez-vous pour superviser le réseau."/> : <>
      <div className="kpi-scroll"><StatCard label="Services" value={services.length} icon={Radio}/><StatCard label="Véhicules" value={vehicles.length} icon={BusFront} tone="primary"/><StatCard label="Incidents ouverts" value={incidents.data?.filter(i=>i.status!=='resolved').length || 0} icon={ShieldAlert}/></div>
      <SectionTitle icon={Radio} title="Unités roulantes en surveillance"/>
      {!services.length && <ApiState resource={fleet} empty="Aucun service à afficher."/>}
      {services.map(s=><Card key={s.id} className="stack"><div className="between"><div><h3>{s.registration || 'Sans affectation'}</h3><span className="small muted">{s.driver_name || 'Sans conducteur'} · {s.route_name}</span></div><Badge tone={s.status==='active'?'success':'neutral'}>{s.status}</Badge></div>
        <div className="notice"><div className="between"><strong>Capacité restante</strong><Armchair size={18}/></div>{s.availability?s.availability.segments.map(segment=><div className="between small" key={segment.sequence}><span>{s.availability.stops[segment.sequence].city} → {s.availability.stops[segment.sequence+1].city}</span><strong>{segment.available} / {s.capacity}</strong></div>):<span>Service terminé</span>}</div>
        <div className="controls">{(s.status==='scheduled'?['active','cancelled']:s.status==='active'?['disrupted','completed']:s.status==='disrupted'?['active','cancelled']:[]).map(status=><button className="btn btn-soft" key={status} disabled={busy || !online} onClick={()=>act(`/services/${s.id}/status`,{status})}>Passer à {status}</button>)}</div>
      </Card>)}
      <SectionTitle icon={BusFront} title="Véhicules du réseau"/>{vehicles.map(v=><Card key={v.id}><div className="between"><h3>{v.registration}</h3><Badge>{v.capacity} places · {v.status}</Badge></div></Card>)}
    </>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <SectionTitle icon={ShieldAlert} title="Incidents & reprise"/>
    {incidents.loading || incidents.error || !incidents.data?.length ? <ApiState resource={incidents} empty="Aucun incident signalé."/> : incidents.data.map(i=><Card key={i.id} className="stack"><div className="between"><h3>{i.kind}</h3><Badge tone={i.status==='resolved'?'success':'danger'}>{i.status}</Badge></div><p>{i.description}</p><div className="controls">
      {i.status!=='resolved' && <button className="btn btn-soft" disabled={busy || !online} onClick={()=>act(`/incidents/${i.id}`,{status:'resolved'},'PATCH')}>Résoudre</button>}
    </div><p className="small muted">Le remplacement de véhicule est disponible par l’API avec contrôle de capacité et conservation du manifeste.</p></Card>)}
    <SectionTitle icon={WalletCards} title="Paiements au guichet"/>
    {bookings.loading || bookings.error || !bookings.data?.length ? <ApiState resource={bookings} empty="Aucune option en attente."/> : <Card className="stack"><label>Référence du reçu<input className="control" value={reference} onChange={e=>setReference(e.target.value)} maxLength={100}/></label><p className="small muted">Enregistrer uniquement un paiement réellement reçu. Cette action ne prélève pas le passager.</p>{bookings.data.filter(b=>b.status==='held').map(b=><div className="between wrap" key={b.id}><span className="small">{b.passenger_name} · {b.amount_minor} FCFA</span><button className="btn btn-primary" disabled={busy || !online || !reference.trim()} onClick={()=>act(`/bookings/${b.id}/payments`,{provider:'cash',reference:reference.trim(),amountMinor:b.amount_minor,currency:'XOF'},'POST','cash-'+b.id)}>Enregistrer le paiement</button></div>)}</Card>}
  </>;
}
