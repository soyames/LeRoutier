import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, StatCard, SectionTitle, ApiState } from '@leroutier/ui';
import { createSyncQueue } from '@leroutier/config/offline';
import QrScanner from 'qr-scanner';
import { Users, Route, BusFront, QrCode, AlertTriangle, Wallet, RefreshCw, Package, MapPin, Navigation } from 'lucide-react';

// Board/alight/incident actions flow through the offline queue: the server
// deduplicates by Idempotency-Key, so retries are always safe.
function useDriverQueue(userId, request) {
  const queue=useRef(null),running=useRef(false);
  const [rows,setRows]=useState([]);
  const refresh=()=>queue.current && setRows(queue.current.read());
  const sync=useCallback(async()=>{
    if(!queue.current || running.current) return;
    running.current=true;
    try {
      await queue.current.sync(row=>row.type==='parcel'
        ? request(`/parcels/${row.payload.parcelId}/scan`,{method:'POST',key:row.id,body:{kind:row.payload.kind}})
        : request('/driver/actions',{method:'POST',key:row.id,body:{type:row.type,payload:row.payload}}));
    }
    finally { running.current=false;refresh(); }
  },[request]);
  useEffect(()=>{
    if(!userId) return;
    queue.current=createSyncQueue(window.localStorage,userId);
    refresh();
    const kick=()=>{sync();refresh();};
    window.addEventListener('online',kick);
    return()=>window.removeEventListener('online',kick);
  },[userId,sync]);
  const enqueue=useCallback((type,payload)=>{queue.current?.enqueue(type,payload);refresh();if(navigator.onLine)sync();},[sync]);
  const retry=useCallback(id=>{queue.current?.retry(id);refresh();},[]);
  const discard=useCallback(id=>{queue.current?.discard(id);refresh();},[]);
  return {rows,sync,enqueue,retry,discard};
}

const parcelLabels={created:'Créé',accepted:'Accepté',manifested:'Affecté',loaded:'Chargé',in_transit:'En transit',arrived:'Arrivé',
  ready_for_pickup:'Prêt au retrait',collected:'Retiré',cancelled:'Annulé',rejected:'Refusé',held:'Retenu',damaged:'Endommagé',
  lost:'Perdu',return_requested:'Retour demandé',returned:'Retourné'};
const parcelTones={created:'neutral',accepted:'neutral',manifested:'neutral',loaded:'neutral',in_transit:'neutral',arrived:'neutral',
  ready_for_pickup:'warning',collected:'success',cancelled:'neutral',rejected:'danger',held:'warning',damaged:'danger',lost:'danger',
  return_requested:'warning',returned:'neutral'};
const payoutLabels={requested:'Demandé',processing:'En cours',paid:'Versé',failed:'Échoué',cancelled:'Annulé',reversed:'Annulé (reversé)'};
const payoutTones={requested:'neutral',processing:'neutral',paid:'success',failed:'danger',cancelled:'neutral',reversed:'danger'};

function useService(){
  const {user}=useSession();
  const service=useApi(user?'/driver/service':null);
  const s=service.data;
  const manifest=useApi(s?`/services/${s.id}/manifest`:null);
  const cargo=useApi(s?'/driver/parcels':null);
  return {user,service,s,manifest,cargo};
}
function VerificationBanner(){
  const {user}=useSession();
  if(!user || user.verification_status==='verified') return null;
  const copy={pending_verification:'Votre compte opérateur est en attente de vérification. Les services et les retraits seront disponibles après validation.',
    rejected:'Votre dossier a été refusé. Mettez à jour votre profil ou contactez LeRoutier.',
    suspended:'Votre compte est suspendu. Contactez LeRoutier.',draft:'Complétez votre dossier pour lancer la vérification.'};
  return <Card className="card-success stack"><Badge tone="warning">Statut : {user.verification_status}</Badge><p className="small">{copy[user.verification_status]||copy.pending_verification}</p></Card>;
}
function QueueStatus({queue}){
  const {online}=useSession();
  const pending=queue.rows.filter(r=>['pending','syncing','failed'].includes(r.state));
  if(!pending.length && online) return null;
  return <Card className="stack"><div className="between"><h3>Actions hors ligne</h3>{pending.length>0 && <Badge tone="warning"><RefreshCw size={13}/>{pending.length} en attente</Badge>}</div>
    {!online && <p role="status">Hors ligne — les actions seront synchronisées à la reconnexion.</p>}
    {pending.map(row=><div className="between wrap" key={row.id}><span className="small">{row.type} · {row.state}{row.error?` · ${row.error}`:''}</span><div>{['failed','conflict'].includes(row.state)&&<button className="btn btn-soft" onClick={()=>row.state==='failed'?queue.retry(row.id):queue.discard(row.id)}>{row.state==='failed'?'Réessayer':'Ignorer'}</button>}</div></div>)}
    {!online && <button className="btn btn-soft" onClick={queue.sync}>Synchroniser maintenant</button>}
  </Card>;
}

export function Today(){
  const {user,request}=useSession();
  const {service,s,manifest}=useService();
  const queue=useDriverQueue(user?.id,request);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  if(!user || service.loading || service.error) return <><VerificationBanner/><SectionTitle title="Aujourd’hui"/><ApiState resource={service} empty={user?'Aucun service ne vous est affecté aujourd’hui. Contactez votre opérateur si cela vous semble anormal.':'Connectez-vous pour voir votre affectation.'}/></>;
  if(!s) return <><VerificationBanner/><SectionTitle title="Aujourd’hui"/><Card><p role="status">Aucun service ne vous est affecté aujourd’hui. Contactez votre opérateur si cela vous semble anormal.</p></Card></>;
  const stop=s.stops.find(stop=>stop.sequence===s.current_sequence);
  return <>
    <VerificationBanner/>
    <Card className="card-dark stack"><div className="between wrap"><div><span className="eyebrow">{s.status}</span><h2>{s.route_name}</h2></div><Badge>{s.registration}</Badge></div>
      <strong>Arrêt courant : {stop?.city}</strong>
      {s.departure_point_name && <span className="small">Embarquement : {s.departure_point_name}{s.departure_point_landmark?` (${s.departure_point_landmark})`:''}</span>}
      {s.arrival_point_name && <span className="small">Terminus : {s.arrival_point_name}{s.arrival_point_landmark?` (${s.arrival_point_landmark})`:''}</span>}
    </Card>
    <div className="grid grid-3"><StatCard label="À bord" value={manifest.data?.filter(b=>b.status==='boarded').length || 0} icon={Users} tone="success"/><StatCard label="Places véhicule" value={s.capacity} icon={BusFront}/><StatCard label="Arrêt" value={s.current_sequence+1} icon={Route}/></div>
    <QueueStatus queue={queue}/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <Card className="stack"><span className="eyebrow">Actions terrain</span>
      {s.current_sequence<s.stops.length-1 && <button className="btn btn-primary" disabled={busy} onClick={()=>{setBusy(true);request(`/services/${s.id}/advance`,{method:'POST',body:{sequence:s.current_sequence+1}}).then(()=>{setNotice('Arrêt suivant enregistré.');service.reload();}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>Arrivée à l’arrêt suivant</button>}
      <button className="btn btn-soft" disabled={busy} onClick={()=>navigator.geolocation? navigator.geolocation.getCurrentPosition(p=>request(`/services/${s.id}/positions`,{method:'POST',body:{latitude:p.coords.latitude,longitude:p.coords.longitude,observedAt:new Date(p.timestamp).toISOString()}}).then(()=>setNotice('Position partagée.')).catch(e=>setError(e.message)),()=>setError('Position indisponible ou autorisation refusée.')):setError('Géolocalisation indisponible.')}>Partager ma position</button>
    </Card>
    <Card className="stack"><SectionTitle icon={AlertTriangle} title="Signaler un incident"/>
      <form className="stack" onSubmit={async e=>{e.preventDefault();const f=new FormData(e.target);queue.enqueue('incident',{serviceId:s.id,kind:'other',severity:'medium',description:String(f.get('description')||'')});e.target.reset();setNotice('Incident enregistré.');if(navigator.onLine)queue.sync();}}>
        <label>Description<textarea className="control" name="description" maxLength={2000} required/></label>
        <button className="btn btn-danger" disabled={busy}>Enregistrer l’incident</button>
      </form></Card>
  </>;
}

export function Manifest(){
  const {request}=useSession();
  const {user,service,s,manifest}=useService();
  const queue=useDriverQueue(user?.id,request);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  async function act(type,payload){
    setBusy(true);setError('');setNotice('');
    try{
      if(type==='board' && payload.code){
        if(navigator.onLine){
          const result=await request('/tickets/verify',{method:'POST',body:{code:payload.code,serviceId:payload.serviceId,stopSequence:payload.stopSequence}});
          payload={bookingId:result.bookingId,serviceId:payload.serviceId,stopSequence:payload.stopSequence};
        }
      }
      queue.enqueue(type,payload);setNotice('Action enregistrée et synchronisée.');
    }catch(e){setError(e.message);}
    finally{setBusy(false);manifest.reload();service.reload();}
  }
  if(!s) return <><SectionTitle icon={Users} title="Manifeste passagers"/><Card><p role="status">Aucun service affecté — le manifeste apparaît ici dès l’affectation.</p></Card></>;
  const stop=s.stops.find(stop=>stop.sequence===s.current_sequence);
  return <>
    <SectionTitle icon={Users} title="Manifeste passagers" trailing={<Badge>{stop?.city}</Badge>}/>
    <QueueStatus queue={queue}/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {manifest.loading || manifest.error || !manifest.data?.length ? <ApiState resource={manifest} empty="Aucun passager confirmé sur ce service pour le moment."/> : manifest.data.map(b=><div className="manifest-row" key={b.id}><div className="seat"><small>Siège</small><strong>{b.seat_number}</strong></div><div><h3>{b.passenger_name}</h3><span className="small muted">{b.id}</span><div><Badge tone={b.status==='boarded'?'success':'neutral'}>{b.status}</Badge></div></div>
      {b.status==='confirmed' && b.origin_sequence===s.current_sequence && <button className="btn btn-primary" disabled={busy} onClick={()=>act('board',{bookingId:b.id,serviceId:s.id,stopSequence:s.current_sequence})}>Embarquer</button>}
      {b.status==='boarded' && b.destination_sequence===s.current_sequence && <button className="btn btn-soft" disabled={busy} onClick={()=>act('alight',{bookingId:b.id,serviceId:s.id,stopSequence:s.current_sequence})}>Débarquer</button>}
    </div>)}
  </>;
}

export function Scanner(){
  const {request}=useSession();
  const {user,service,s,manifest}=useService();
  const queue=useDriverQueue(user?.id,request);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[code,setCode]=useState(''),[scanning,setScanning]=useState(false);
  const scanner=useRef(null);
  useEffect(()=>()=>{scanner.current?.stop();scanner.current?.destroy();},[]);
  async function act(type,payload){
    setBusy(true);setError('');setNotice('');
    try{
      if(type==='board' && payload.code){
        if(navigator.onLine){
          const result=await request('/tickets/verify',{method:'POST',body:{code:payload.code,serviceId:payload.serviceId,stopSequence:payload.stopSequence}});
          payload={bookingId:result.bookingId,serviceId:payload.serviceId,stopSequence:payload.stopSequence};
        }
      }
      queue.enqueue(type,payload);setNotice('Billet valide — embarquement enregistré.');
    }catch(e){setError(e.message);}
    finally{setBusy(false);manifest.reload();service.reload();}
  }
  async function scan(){
    setError('');setScanning(true);
    try{
      scanner.current=new QrScanner(/** @type {HTMLVideoElement} */(document.getElementById('qr-video')),result=>{
        const match=/^LRT1\.[A-Za-z0-9_-]+$/.test(result.data)?result.data:null;
        if(match){scanner.current?.stop();setScanning(false);act('board',{code:match,serviceId:s.id,stopSequence:s.current_sequence});}
        else setError('QR inconnu — il ne s’agit pas d’un billet LeRoutier.');
      },{highlightScanRegion:true});
      await scanner.current.start();
    }catch{setScanning(false);setError('Caméra indisponible — saisissez le code du billet manuellement.');}
  }
  if(!s) return <><SectionTitle icon={QrCode} title="Contrôle des billets"/><Card><p role="status">Aucun service affecté — le contrôle des billets n’est pas disponible.</p></Card></>;
  return <>
    <SectionTitle icon={QrCode} title="Contrôle des billets"/>
    <QueueStatus queue={queue}/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <Card className="scanner stack">
      <p className="small">Scannez le QR du billet ou saisissez son code manuel. Les actions s’enregistrent même hors ligne et se synchronisent à la reconnexion.</p>
      <div className="between wrap">
        <label className="grow">Code du billet<input className="control" placeholder="LRT1.… ou LR-XXXX-XXXX" value={code} onChange={e=>setCode(e.target.value)}/></label>
        <button className="btn btn-primary" disabled={busy || !code.trim()} onClick={()=>act('board',{code:code.trim(),serviceId:s.id,stopSequence:s.current_sequence})}>Valider le billet</button>
        {!scanning?<button className="btn btn-soft" onClick={scan}>Scanner le QR</button>:<button className="btn btn-soft" onClick={()=>{scanner.current?.stop();setScanning(false);}}>Arrêter la caméra</button>}
      </div>
      {scanning && <video id="qr-video" className="qr-video" muted playsInline aria-label="Lecture caméra QR"/>}
    </Card>
  </>;
}

export function WalkUp(){
  const {request,online}=useSession();
  const {s,manifest}=useService();
  const [origin,setOrigin]=useState(''),[destination,setDestination]=useState(''),[name,setName]=useState(''),[phone,setPhone]=useState(''),[amount,setAmount]=useState(''),[reference,setReference]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  async function submit(e){
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      const result=await request('/driver/walk-up-bookings',{method:'POST',key:'walkup-'+crypto.randomUUID(),body:{serviceId:s.id,
        origin:Number(origin),destination:Number(destination),passengerName:name,passengerPhone:phone,amountMinor:Number(amount),cashReference:reference.trim()}});
      setNotice(`Vente enregistrée — ${result.amountMinor.toLocaleString('fr-FR')} FCFA encaissés (recette opérateur).`);setName('');setPhone('');setAmount('');setReference('');manifest.reload?.();
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  if(!s) return <><SectionTitle icon={Wallet} title="Vente au comptant"/><Card><p role="status">Aucun service affecté — la vente au comptant n’est pas disponible.</p></Card></>;
  const stops=s.stops||[];
  return <>
    <SectionTitle icon={Wallet} title="Vente au comptant (montée directe)"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <Card className="stack">
      <p className="small muted">Le paiement en espèces n’existe qu’ici, par l’équipage du service. Le montant doit correspondre exactement au tarif du tronçon — la recette appartient à l’opérateur.</p>
      <form className="stack" onSubmit={submit}>
        <div className="between wrap">
          <label className="grow">Montée<select className="control" required value={origin} onChange={e=>setOrigin(e.target.value)}><option value="">Choisir…</option>{stops.map((st,index)=><option key={index} value={index}>{st.city}</option>)}</select></label>
          <label className="grow">Descente<select className="control" required value={destination} onChange={e=>setDestination(e.target.value)}><option value="">Choisir…</option>{stops.map((st,index)=><option key={index} value={index}>{st.city}</option>)}</select></label>
        </div>
        <div className="between wrap">
          <label className="grow">Nom du passager<input className="control" required minLength={2} value={name} onChange={e=>setName(e.target.value)}/></label>
          <label className="grow">Téléphone<input className="control" type="tel" required value={phone} onChange={e=>setPhone(e.target.value)}/></label>
          <label className="grow">Montant (FCFA)<input className="control" type="number" min={1} step={1} required value={amount} onChange={e=>setAmount(e.target.value)}/></label>
          <label className="grow">Référence du reçu<input className="control" required value={reference} onChange={e=>setReference(e.target.value)}/></label>
        </div>
        <button className="btn btn-primary" disabled={busy || !online || !origin || !destination || Number(origin)>=Number(destination)}>{busy?'Enregistrement…':'Encaisser et embarquer'}</button>
      </form>
    </Card>
  </>;
}

export function Parcels(){
  const {request,online}=useSession();
  const {user,s,cargo}=useService();
  const queue=useDriverQueue(user?.id,request);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  async function reportProblem(p){
    const description=window.prompt('Décrivez le problème constaté sur le colis :');
    if(!description || !description.trim()) return;
    setBusy(true);setError('');
    try{await request(`/parcels/${p.id}/exceptions`,{method:'POST',body:{kind:'damaged',description:description.trim()}});setNotice('Problème signalé à la régulation.');cargo.reload?.();}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  if(!s) return <><SectionTitle icon={Package} title="Fret & colis"/><Card><p role="status">Aucun service affecté — les colis du service apparaissent ici.</p></Card></>;
  return <>
    <SectionTitle icon={Package} title="Fret & colis" trailing={cargo.data?.length?<Badge>{cargo.data.length} colis</Badge>:null}/>
    <QueueStatus queue={queue}/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {cargo.loading || cargo.error || !cargo.data?.length ? <ApiState resource={cargo} empty="Aucun colis affecté à ce service pour le moment."/> : cargo.data.map(p=><Card key={p.id} className="between wrap"><div className="stack"><div className="between"><h3>{p.trackingNumber}</h3><Badge tone={parcelTones[p.status]}>{parcelLabels[p.status]}</Badge></div>
      <span className="small muted">{p.category} · {p.quantity} pièce(s){p.weightG?` · ${p.weightG}g`:''} · destination {p.destinationCity}</span></div>
      <div className="controls">
        {p.status==='manifested' && <button className="btn btn-primary" disabled={busy} onClick={()=>queue.enqueue('parcel',{serviceId:s.id,parcelId:p.id,kind:'loaded'})}>Scanner le chargement</button>}
        {p.status==='loaded' && <button className="btn btn-primary" disabled={busy} onClick={()=>queue.enqueue('parcel',{serviceId:s.id,parcelId:p.id,kind:'departed'})}>Scanner le départ</button>}
        {p.status==='in_transit' && <button className="btn btn-primary" disabled={busy} onClick={()=>queue.enqueue('parcel',{serviceId:s.id,parcelId:p.id,kind:'arrived'})}>Scanner l’arrivée</button>}
        {(p.status==='loaded'||p.status==='in_transit') && <button className="btn btn-soft" disabled={busy || !online} onClick={()=>reportProblem(p)}>Signaler un problème</button>}
      </div></Card>)}
  </>;
}

export function Vehicle(){
  const {s}=useService();
  if(!s) return <><SectionTitle icon={BusFront} title="Véhicule"/><Card><p role="status">Aucun véhicule affecté — l’affectation apparaît ici.</p></Card></>;
  return <>
    <SectionTitle icon={BusFront} title="Véhicule"/>
    <Card className="stack"><div className="between"><h2>{s.registration}</h2><Badge tone="success">{s.capacity} places</Badge></div>
      <p className="small muted">{s.route_name} · statut {s.status}</p>
      {s.departure_point_name && <span className="small">Embarquement : {s.departure_point_name}{s.departure_point_landmark?` (${s.departure_point_landmark})`:''}</span>}
    </Card>
  </>;
}

// Independent owner-driver only: search verified boarding points or propose a
// missing one. Proposals stay clearly "pending verification".
export function Points(){
  const {user,request,online}=useSession();
  const [q,setQ]=useState(''),[results,setResults]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [name,setName]=useState(''),[placeId,setPlaceId]=useState(''),[type,setType]=useState('independent_boarding_point'),[description,setDescription]=useState(''),[purposes,setPurposes]=useState(['passenger_boarding']);
  const places=useApi('/places');
  async function search(e){
    e.preventDefault();setBusy(true);setError('');
    try{setResults(await request('/boarding-points?q='+encodeURIComponent(q)));}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  function togglePurpose(p){setPurposes(list=>list.includes(p)?list.filter(x=>x!==p):[...list,p]);}
  async function propose(e){
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      await request('/boarding-points/proposals',{method:'POST',body:{name,placeId,type,description:description.trim()||undefined,purposes}});
      setNotice('Point proposé — en attente de vérification avant de devenir une adresse de confiance.');setName('');setDescription('');
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  if(!user || !(user.operator_type==='independent' && user.role==='driver')) return <Card><p role="status">La gestion des points d’embarquement est réservée aux chauffeurs indépendants.</p></Card>;
  return <>
    <SectionTitle icon={MapPin} title="Points d’embarquement & colis"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <Card className="stack"><form className="between wrap" onSubmit={search}>
      <label className="grow">Rechercher un point vérifié<input className="control" placeholder="Nom, quartier…" value={q} onChange={e=>setQ(e.target.value)}/></label>
      <button className="btn btn-soft" disabled={busy || !online || !q.trim()}>Rechercher</button></form>
      {(results||[]).map(p=><div className="between wrap" key={p.id}><div className="stack"><h3>{p.name}</h3><span className="small muted">{p.city} · {p.type} · {(p.purposes||[]).join(', ')}</span>{p.status!=='verified' && <Badge tone="warning">Vérification en attente</Badge>}</div></div>)}
      {results && results.length===0 && <p role="status">Aucun point vérifié trouvé — proposez-le ci-dessous.</p>}
    </Card>
    <Card className="stack"><SectionTitle title="Proposer un nouveau point"/>
      <p className="small muted">Les propositions sont examinées avant de devenir des adresses de confiance.</p>
      <form className="stack" onSubmit={propose}>
        <label>Nom du point<input className="control" required minLength={2} maxLength={200} value={name} onChange={e=>setName(e.target.value)}/></label>
        <label>Localité<select className="control" required value={placeId} onChange={e=>setPlaceId(e.target.value)}><option value="">Choisir…</option>{(places.data||[]).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Type<select className="control" value={type} onChange={e=>setType(e.target.value)}>
          <option value="independent_boarding_point">Point d’embarquement indépendant</option>
          <option value="roadside_pickup">Ramassage en bord de route</option>
          <option value="parcel_consignment_point">Point de dépôt colis</option>
          <option value="parcel_pickup_point">Point de retrait colis</option>
        </select></label>
        <label>Repère / adresse (facultatif)<input className="control" maxLength={1000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
        <div className="controls wrap">
          {['passenger_boarding','passenger_alighting','parcel_consignment','parcel_pickup'].map(p=><button type="button" key={p} className={purposes.includes(p)?'btn btn-primary':'btn btn-soft'} onClick={()=>togglePurpose(p)}>{p==='passenger_boarding'?'Embarquement':p==='passenger_alighting'?'Dépose':p==='parcel_consignment'?'Dépôt colis':'Retrait colis'}</button>)}
        </div>
        <button className="btn btn-primary" disabled={busy || !online || !name.trim() || !placeId || !purposes.length}>Proposer le point</button>
      </form>
    </Card>
  </>;
}

export function Earnings(){
  const {user,request,online}=useSession();
  const data=useApi(user?'/driver/earnings':null),payouts=useApi(user?'/driver/payouts':null),destinations=useApi(user?'/driver/payout-destinations':null);
  const independent=user?.operator_type==='independent' && user?.role==='driver';
  const operatorData=useApi(independent?'/operator/settlements':null),operatorPayouts=useApi(independent?'/operator/payouts':null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [amount,setAmount]=useState(''),[destinationId,setDestinationId]=useState('');
  const [phone,setPhone]=useState(''),[country,setCountry]=useState('BJ'),[network,setNetwork]=useState('');
  const [opAmount,setOpAmount]=useState(''),[opPhone,setOpPhone]=useState(user?.phone||'');
  const summary=data.data?.summary || {available:0,reserved:0,paid:0,reversed:0};
  async function act(path,body,key){setBusy(true);setError('');setNotice('');try{await request(path,{method:'POST',body,key});payouts.reload();destinations.reload();data.reload();operatorData.reload?.();operatorPayouts.reload?.();setNotice('Action enregistrée.');}catch(e){setError(e.message);}finally{setBusy(false);}}
  if(!user) return <Card><p role="status">Connectez-vous pour voir vos gains.</p></Card>;
  return <>
    <SectionTitle icon={Wallet} title="Mes gains & versements"/>
    <VerificationBanner/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {independent && operatorData.data && <Card className="card-success stack"><SectionTitle icon={Wallet} title="Recette de mon activité indépendante"/>
      <div className="grid grid-3">
        <StatCard label="Disponible" value={`${(operatorData.data.summary.available).toLocaleString('fr-FR')} FCFA`} tone="success"/>
        <StatCard label="En attente" value={`${operatorData.data.summary.reserved.toLocaleString('fr-FR')} FCFA`}/>
        <StatCard label="Versé" value={`${operatorData.data.summary.paid.toLocaleString('fr-FR')} FCFA`}/>
      </div>
      {operatorData.data.summary.verificationStatus!=='verified' && <p role="status">Compte en attente de vérification — les retraits seront possibles après validation.</p>}
      <div className="between wrap">
        <label className="grow">Montant du retrait (FCFA)<input className="control" type="number" min={1} step={1} value={opAmount} onChange={e=>setOpAmount(e.target.value)}/></label>
        <label className="grow">Numéro Mobile Money<input className="control" type="tel" inputMode="numeric" value={opPhone} onChange={e=>setOpPhone(e.target.value.replace(/[^0-9]/g,''))}/></label>
        <button className="btn btn-primary" disabled={busy || !online || operatorData.data.summary.verificationStatus!=='verified' || !Number.isInteger(Number(opAmount)) || Number(opAmount)<=0 || !/^[0-9]{8,15}$/.test(opPhone)} onClick={()=>act('/operator/payouts',{amountMinor:Number(opAmount),phoneNumber:opPhone,country:'BJ',network:null},'oppayout-'+crypto.randomUUID())}>Demander le retrait</button>
      </div>
      {(operatorPayouts.data||[]).map(p=><div className="between" key={p.id}><span className="small">{p.amountMinor.toLocaleString('fr-FR')} FCFA · {p.phoneNumber}</span><Badge tone={payoutTones[p.status]}>{payoutLabels[p.status]}</Badge></div>)}
    </Card>}
    {!independent && <Card className="stack"><p className="small muted">Vos gains sont gérés par votre opérateur. Les versements et la recette de la compagnie ne sont pas accessibles ici.</p></Card>}
    <div className="grid grid-3">
      <StatCard label="Disponible" value={`${summary.available.toLocaleString('fr-FR')} FCFA`} icon={Wallet} tone="success"/>
      <StatCard label="En attente" value={`${summary.reserved.toLocaleString('fr-FR')} FCFA`} icon={RefreshCw}/>
      <StatCard label="Versé" value={`${summary.paid.toLocaleString('fr-FR')} FCFA`} icon={BusFront} tone="primary"/>
    </div>
    <Card className="stack"><SectionTitle title="Demander un versement"/>
      {(!destinations.data || !destinations.data.length) && <p className="small">Ajoutez d’abord une destination Mobile Money (numéro auquel envoyer vos gains).</p>}
      <label>Destination<select className="control" value={destinationId} onChange={e=>setDestinationId(e.target.value)}>
        <option value="">Choisir…</option>
        {(destinations.data||[]).filter(d=>d.active).map(d=><option key={d.id} value={d.id}>{d.phoneNumber} {d.network?`(${d.network.toUpperCase()})`:''}{d.verified?'':' · non vérifié'}</option>)}
      </select></label>
      <label>Montant (FCFA)<input className="control" type="number" min={1} step={1} value={amount} onChange={e=>setAmount(e.target.value)}/></label>
      <button className="btn btn-primary" disabled={busy || !online || !destinationId || !Number.isInteger(Number(amount)) || Number(amount)<=0} onClick={()=>act('/driver/payouts',{destinationId,amountMinor:Number(amount)},'payout-'+crypto.randomUUID())}>Demander le versement</button>
      <p className="small muted">Le solde est réservé dès la demande. Le versement part après validation par la régulation — il n’est « versé » qu’une fois confirmé par le prestataire.</p>
    </Card>
    <Card className="stack"><SectionTitle title="Destination de versement"/>
      <div className="between wrap">
        <label>Numéro Mobile Money<input className="control" type="tel" inputMode="numeric" placeholder="Sans indicatif, ex. 61234567" value={phone} onChange={e=>setPhone(e.target.value.replace(/[^0-9]/g,''))} maxLength={15}/></label>
        <label>Pays<select className="control" value={country} onChange={e=>setCountry(e.target.value)}><option value="BJ">Bénin</option><option value="CI">Côte d’Ivoire</option><option value="TG">Togo</option></select></label>
        <label>Réseau<select className="control" value={network} onChange={e=>setNetwork(e.target.value)}><option value="">Auto</option><option value="mtn">MTN</option><option value="moov">Moov</option></select></label>
        <button className="btn btn-soft" disabled={busy || !online || !/^[0-9]{8,15}$/.test(phone)} onClick={()=>act('/driver/payout-destinations',{country,phoneNumber:phone,network:network||null})}>Ajouter</button>
      </div>
      {(destinations.data||[]).map(d=><div className="between" key={d.id}><span className="small">{d.phoneNumber} · {d.country.toUpperCase()}{d.network?` · ${d.network.toUpperCase()}`:''}{d.verified?<Badge tone="success">vérifié</Badge>:<Badge>non vérifié</Badge>}</span></div>)}
    </Card>
    <SectionTitle title="Historique des versements"/>
    {payouts.loading || payouts.error || !payouts.data?.length ? <ApiState resource={payouts} empty="Aucun versement demandé."/> : payouts.data.map(p=><Card key={p.id} className="between"><div><h3>{p.amountMinor.toLocaleString('fr-FR')} FCFA</h3><span className="small muted">{new Date(p.createdAt).toLocaleString('fr-FR')} · {p.currency}</span></div><div className="stack end"><Badge tone={payoutTones[p.status]}>{payoutLabels[p.status]}</Badge>{p.status==='requested'&&<button className="btn btn-soft" disabled={busy || !online} onClick={()=>act(`/driver/payouts/${p.id}/cancel`)}>Annuler</button>}</div></Card>)}
    <SectionTitle icon={Wallet} title="Détail des gains"/>
    {(!data.data || !data.data.entries.length) ? <ApiState resource={data} empty="Aucun gain enregistré pour le moment."/> : data.data.entries.map(e=><Card key={e.id} className="between"><div><h3>{e.net_minor.toLocaleString('fr-FR')} FCFA</h3><span className="small muted">{e.source} · {e.reference} · {new Date(e.earned_at).toLocaleDateString('fr-FR')}</span></div><div className="stack end"><Badge tone={e.payout_state==='paid'?'success':e.payout_state==='reserved'?'neutral':'danger'}>{e.payout_state==='available'?'disponible':e.payout_state==='reserved'?'réservé':e.payout_state==='paid'?'versé':'reversé'}</Badge><span className="small muted">brut {e.gross_minor.toLocaleString('fr-FR')}{e.deduction_minor>0?` − déduction ${e.deduction_minor.toLocaleString('fr-FR')}`:''}</span></div></Card>)}
  </>;
}

export function Profile(){
  const {user}=useSession(),service=useApi(user?'/driver/service':null);
  return <><VerificationBanner/>
    <Card className="stack"><h2>{user?.display_name || 'Profil'}</h2><span className="small muted">{user?.role==='convoyeur'?'Compte convoyeur':'Compte conducteur'}{user?.operator_type==='independent'?' · indépendant':''}</span></Card>
    <Card className="stack"><SectionTitle icon={BusFront} title="Affectation véhicule"/>{service.data?<><h3>{service.data.registration}</h3><p>{service.data.route_name}</p><Badge>{service.data.capacity} places</Badge></>:<ApiState resource={service} empty="Aucune affectation disponible."/>}</Card>
    <Card className="stack"><SectionTitle icon={Navigation} title="Ma position sur le réseau"/><p className="small muted">Partagez votre position depuis l’écran Aujourd’hui pendant le service — elle alimente le suivi des passagers.</p></Card>
  </>;
}
