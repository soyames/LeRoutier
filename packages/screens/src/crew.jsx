import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi, useSession, IDENTITY_ERROR_CODES } from '@leroutier/config/client';
import { Card, Badge, StatCard, SectionTitle, ApiState, ErrorState, SkeletonCards } from '@leroutier/ui';
import { status, fcfa, time, untilLabel } from '@leroutier/ui';
import { createSyncQueue } from '@leroutier/config/offline';
import { useVehicleTracking } from './vehicle-gps.js';
import QrScanner from 'qr-scanner';
import { Users, BusFront, QrCode, AlertTriangle, Wallet, RefreshCw, Package, MapPin, Navigation } from 'lucide-react';

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
  const state=status('verification',user.verification_status);
  const copy={pending_verification:'Nous vérifions votre dossier. Vous pourrez publier des services et retirer vos recettes dès validation.',
    rejected:'Votre dossier a été refusé. Mettez à jour vos informations ou contactez LeRoutier.',
    suspended:'Votre compte est suspendu. Contactez LeRoutier pour le rétablir.',
    draft:'Complétez votre dossier pour lancer la vérification.'};
  return <Card className="stack"><div className="between wrap"><strong>{state.label}</strong><Badge tone={state.tone}>{state.label}</Badge></div>
    <p className="small">{copy[user.verification_status]||copy.pending_verification}</p></Card>;
}

// What a queued action means to the person who performed it.
const ACTION_LABELS={board:'Embarquement',alight:'Débarquement',incident:'Incident signalé',parcel:'Colis scanné'};

function QueueStatus({queue}){
  const {online}=useSession();
  const waiting=queue.rows.filter(r=>['pending','syncing'].includes(r.state));
  const failed=queue.rows.filter(r=>r.state==='failed');
  const conflicts=queue.rows.filter(r=>r.state==='conflict');
  if(!waiting.length && !failed.length && !conflicts.length && online) return null;
  return <Card className="stack">
    <div className="between wrap">
      <strong>{!online?'Hors ligne':'Synchronisation'}</strong>
      {waiting.length>0 && <Badge tone="warning"><RefreshCw size={13}/>{waiting.length} action{waiting.length>1?'s':''} en attente</Badge>}
      {!waiting.length && !failed.length && !conflicts.length && <Badge tone="success">À jour</Badge>}
    </div>
    {!online && <p className="small" role="status">Vos scans sont enregistrés sur l’appareil et partiront automatiquement dès le retour du réseau.</p>}
    {conflicts.length>0 && <p className="small" role="status">{conflicts.length} action{conflicts.length>1?'s demandent':' demande'} votre attention : la situation a changé entre-temps.</p>}
    {[...failed,...conflicts].map(row=><div className="between wrap" key={row.id}>
      <span className="small">{ACTION_LABELS[row.type]||'Action'} · {row.state==='failed'?'non envoyé':'à vérifier'}</span>
      <button className="btn btn-soft" onClick={()=>row.state==='failed'?queue.retry(row.id):queue.discard(row.id)}>
        {row.state==='failed'?'Réessayer':'Ignorer'}</button>
    </div>)}
    {online && waiting.length>0 && <button className="btn btn-soft" onClick={queue.sync}>Synchroniser maintenant</button>}
  </Card>;
}

// Live vehicle tracking for the service being run. Permission is asked for
// only once the crew turn it on, and capture stops when the service does.
function VehicleTracking({serviceId,serviceStatus}){
  const {request}=useSession();
  const [enabled,setEnabled]=useState(false);
  const running=['active','disrupted'].includes(serviceStatus);
  const {state,lastSentAt,pending}=useVehicleTracking({serviceId,enabled:enabled&&running,request});
  const copy={
    off:{label:'Suivi désactivé',tone:'neutral',help:'Activez le suivi pour que vos passagers voient la position du véhicule pendant le trajet.'},
    requesting:{label:'Autorisation demandée',tone:'warning',help:'Autorisez la localisation pour activer le suivi du véhicule pendant ce trajet.'},
    active:{label:'Suivi actif',tone:'success',help:'Vos passagers voient la position du véhicule. Gardez cette page ouverte pendant le trajet.'},
    denied:{label:'Localisation refusée',tone:'danger',help:'La localisation est bloquée pour ce site. Autorisez-la dans les réglages du navigateur, puis réactivez le suivi.'},
    unavailable:{label:'GPS indisponible',tone:'danger',help:'Cet appareil ne fournit pas de position exploitable pour le moment.'},
    offline:{label:'Hors ligne — positions en attente',tone:'warning',help:'Les positions sont conservées sur l’appareil et repartiront dès le retour du réseau.'},
  }[state]??{label:'Suivi désactivé',tone:'neutral',help:''};
  if(!running) return null;
  return <Card className="stack">
    <div className="between wrap">
      <strong>Suivi du véhicule</strong>
      <Badge tone={copy.tone}><Navigation size={13}/>{copy.label}</Badge>
    </div>
    <p className="small muted">{copy.help}</p>
    {lastSentAt && <p className="small muted">Dernière position transmise à {time(lastSentAt)}.</p>}
    {pending>0 && <p className="small muted" role="status">{pending} position{pending>1?'s':''} en attente d’envoi.</p>}
    <button className={enabled?'btn btn-soft':'btn btn-primary'} onClick={()=>setEnabled(v=>!v)}>
      {enabled?'Arrêter le suivi':'Activer le suivi du véhicule'}</button>
    {/* An honest statement of what the web platform can and cannot do. */}
    {enabled && <p className="small muted">Le suivi web s’interrompt si cette page est fermée ou mise en arrière-plan par le téléphone.</p>}
  </Card>;
}

// The crew home screen answers, at a glance and one-handed: what am I running,
// how full is it, what is next, and what do I press now. Dense tables, revenue
// and long forms belong elsewhere.
export function Today(){
  const {user,request,online}=useSession();
  const navigate=useNavigate();
  const {service,s,manifest,cargo}=useService();
  const queue=useDriverQueue(user?.id,request);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [incidentOpen,setIncidentOpen]=useState(false);
  const convoyeur=user?.role==='convoyeur';

  if(!user) return <><SectionTitle title="Aujourd’hui"/><Card className="stack"><strong>Connectez-vous</strong>
    <p className="small muted">Votre service du jour s’affiche ici.</p></Card></>;
  if(service.loading) return <><VerificationBanner/><SectionTitle title="Aujourd’hui"/><SkeletonCards count={2} lines={4}/></>;
  if(service.error) return <><VerificationBanner/><SectionTitle title="Aujourd’hui"/>
    {/* An identity problem is the user's to act on, so it is stated plainly;
        anything else is a transient failure they can simply retry. */}
    <ErrorState title={IDENTITY_ERROR_CODES.includes(service.code)?'Accès impossible':'Chargement impossible'}
      text={IDENTITY_ERROR_CODES.includes(service.code)?service.error:'Impossible de charger votre service.'}
      onRetry={IDENTITY_ERROR_CODES.includes(service.code)?undefined:service.reload}/></>;
  if(!s) return <><VerificationBanner/><SectionTitle title="Aujourd’hui"/>
    <Card className="stack"><strong>Aucun service aujourd’hui</strong>
      <p className="small muted">Aucun départ ne vous est affecté. Prévenez votre exploitation si cela vous semble anormal.</p></Card></>;

  const stops=s.stops||[];
  const stop=stops.find(x=>x.sequence===s.current_sequence);
  const next=stops.find(x=>x.sequence===s.current_sequence+1);
  const aboard=(manifest.data||[]).filter(b=>b.status==='boarded').length;
  const expected=(manifest.data||[]).filter(b=>['confirmed','boarded'].includes(b.status)).length;
  const parcels=(cargo.data||[]).length;
  const state=status('service',s.status);
  const countdown=untilLabel(s.departure_at);

  return <>
    <VerificationBanner/>
    {/* One glanceable operational header. */}
    <Card className="card-dark duty">
      <div className="duty-top">
        <div>
          <span className="eyebrow" style={{color:'#fff',opacity:.8}}>{convoyeur?'Mon service':'Ma feuille de route'}</span>
          <div className="duty-time">{time(s.departure_at)}</div>
          <strong>{stops[0]?.city} → {stops.at(-1)?.city}</strong>
        </div>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>
      <div className="duty-metrics">
        <div className="duty-metric"><strong>{aboard}/{expected||0}</strong><span>à bord</span></div>
        <div className="duty-metric"><strong>{Math.max(0,(s.capacity??0)-aboard)}</strong><span>places libres</span></div>
        <div className="duty-metric"><strong>{parcels}</strong><span>colis</span></div>
      </div>
      <span className="small">
        {stop?`Arrêt actuel : ${stop.city}`:''}{next?` · Prochain : ${next.city}`:''}{countdown?` · Départ ${countdown}`:''}
      </span>
    </Card>

    <QueueStatus queue={queue}/>
    {error && <ErrorState title="Action impossible" text={error}/>}
    {notice && <div className="notice" role="status">{notice}</div>}

    {/* Two or three big targets, usable without looking closely. */}
    <div className="big-actions">
      <button className="btn btn-primary" onClick={()=>navigate('/work/scanner')}><QrCode size={20}/>Scanner un billet</button>
      <button className="btn btn-dark" onClick={()=>navigate('/work/walk-up')}><Wallet size={20}/>Vendre une place</button>
      <button className="btn btn-soft" onClick={()=>navigate('/work/parcels')}><Package size={20}/>Colis</button>
    </div>

    <Card className="stack">
      {s.current_sequence<stops.length-1 && <button className="btn btn-primary" disabled={busy||!online} onClick={()=>{
        setBusy(true);setError('');
        request(`/services/${s.id}/advance`,{method:'POST',body:{sequence:s.current_sequence+1}})
          .then(()=>{setNotice(`Arrivée à ${next?.city??'l’arrêt suivant'} enregistrée.`);service.reload();})
          .catch(e=>setError(e.message)).finally(()=>setBusy(false));
      }}>Je suis arrivé à {next?.city??'l’arrêt suivant'}</button>}
    </Card>

    {/* Live vehicle tracking, for this service only. */}
    <VehicleTracking serviceId={s.id} serviceStatus={s.status}/>

    {/* Reporting is deliberately behind one tap: it is a stopped-vehicle task. */}
    <Card className="stack">
      {!incidentOpen
        ? <button className="btn btn-soft" onClick={()=>setIncidentOpen(true)}><AlertTriangle size={16}/>Signaler un problème</button>
        : <form className="stack" onSubmit={e=>{
          e.preventDefault();const f=new FormData(e.target);
          queue.enqueue('incident',{serviceId:s.id,kind:'other',severity:'medium',description:String(f.get('description')||'')});
          e.target.reset();setIncidentOpen(false);setNotice('Problème signalé à l’exploitation.');if(navigator.onLine)queue.sync();
        }}>
          <label>Que se passe-t-il ?<textarea className="control" name="description" maxLength={2000} required rows={3}
            placeholder="Panne, retard, route bloquée…"/></label>
          <div className="controls">
            <button className="btn btn-danger">Envoyer le signalement</button>
            <button type="button" className="btn btn-soft" onClick={()=>setIncidentOpen(false)}>Annuler</button>
          </div>
          <p className="small muted">Fonctionne hors ligne : le signalement partira dès le retour du réseau.</p>
        </form>}
    </Card>
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

// Selling a seat at the roadside must take well under a minute: the fare comes
// from the service itself rather than the crew's memory, and the receipt
// reference is pre-filled but stays editable for a paper receipt book.
export function WalkUp(){
  const {user,request,online}=useSession();
  const {s,manifest}=useService();
  const [destination,setDestination]=useState(''),[name,setName]=useState(''),[phone,setPhone]=useState('');
  const [receipt,setReceipt]=useState(()=>'ESP-'+Date.now().toString(36).toUpperCase());
  const [error,setError]=useState(''),[done,setDone]=useState(null),[busy,setBusy]=useState(false);
  // Boarding always happens where the vehicle is now.
  const origin=s?.current_sequence ?? 0;
  const quote=useApi(s && destination!=='' ? `/services/${s.id}/availability?origin=${origin}&destination=${destination}` : null);
  const fare=quote.data?.fare?.amountMinor ?? null;
  const seats=quote.data?.available ?? null;
  async function submit(e){
    e.preventDefault();setBusy(true);setError('');setDone(null);
    try{
      const result=await request('/driver/walk-up-bookings',{method:'POST',key:'walkup-'+crypto.randomUUID(),body:{serviceId:s.id,
        origin,destination:Number(destination),passengerName:name.trim(),passengerPhone:phone.trim(),amountMinor:fare,cashReference:receipt.trim()}});
      setDone({amount:result.amountMinor,reference:receipt.trim(),to:(s.stops||[])[Number(destination)]?.city});
      setName('');setPhone('');setDestination('');setReceipt('ESP-'+Date.now().toString(36).toUpperCase());
      manifest.reload?.();
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  if(!s) return <><SectionTitle icon={Wallet} title="Vente à bord"/>
    <Card className="stack"><strong>Aucun service en cours</strong>
      <p className="small muted">La vente à bord s’active dès qu’un service vous est affecté.</p></Card></>;
  const stops=s.stops||[];
  const owner=user?.operator_type==='independent'?'votre activité':(user?.operator_name||'la compagnie');
  return <>
    <SectionTitle icon={Wallet} title="Vente à bord"/>
    {error && <ErrorState title="Vente non enregistrée" text={error}/>}
    {done && <Card className="card-success stack">
      <div className="between wrap"><h3>Encaissé · {fcfa(done.amount)}</h3><Badge tone="success">Passager embarqué</Badge></div>
      <div className="summary">
        <div className="row"><span>Destination</span><span>{done.to}</span></div>
        <div className="row"><span>Reçu</span><span>{done.reference}</span></div>
        <div className="row"><span>Recette de</span><span>{owner}</span></div>
      </div>
    </Card>}
    <Card className="stack">
      <form className="stack" onSubmit={submit}>
        <label>Descend à<select className="control" required value={destination} onChange={e=>setDestination(e.target.value)}>
          <option value="">Choisir l’arrêt…</option>
          {stops.map((st,index)=>index>origin?<option key={index} value={index}>{st.city}</option>:null)}
        </select></label>
        {fare!==null && <div className="summary">
          <div className="row"><span>À encaisser</span><span><strong>{fcfa(fare)}</strong></span></div>
          <div className="row"><span>Places restantes</span><span>{seats}</span></div>
        </div>}
        {destination!=='' && quote.loading && <p className="small muted" role="status">Calcul du tarif…</p>}
        {destination!=='' && quote.error && <p className="small muted" role="alert">Tarif indisponible pour ce trajet.</p>}
        <label>Nom du passager<input className="control" required minLength={2} value={name} onChange={e=>setName(e.target.value)}/></label>
        <label>Téléphone<input className="control" type="tel" required value={phone} onChange={e=>setPhone(e.target.value)}/></label>
        <details><summary className="small">Référence du reçu · {receipt}</summary>
          <label style={{display:'block',marginTop:10}}>Remplacer par votre numéro de reçu papier
            <input className="control" required value={receipt} onChange={e=>setReceipt(e.target.value)}/></label></details>
        <button className="btn btn-primary" disabled={busy || !online || fare===null || !seats}>
          {busy?'Enregistrement…':fare!==null?`Encaisser ${fcfa(fare)}`:'Choisir la destination'}</button>
        <p className="small muted">Les espèces ne sont encaissées que par l’équipage, à bord. La recette revient à {owner}.</p>
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
  if(!user) return <Card className="stack"><strong>Connectez-vous</strong>
    <p className="small muted">Vos recettes s’affichent ici.</p></Card>;
  // Company crew are paid by their employer: no ledger and no withdrawal
  // control is presented to them at all. The API enforces this independently.
  if(!independent) return <>
    <SectionTitle icon={Wallet} title="Recettes"/>
    <Card className="stack">
      <strong>Les recettes reviennent à {user.operator_name||'votre compagnie'}</strong>
      <p className="small muted">Les sommes encaissées à bord appartiennent à la compagnie qui vous emploie. Votre rémunération est gérée par votre exploitation, en dehors de LeRoutier.</p>
    </Card>
  </>;
  return <>
    <SectionTitle icon={Wallet} title="Mes recettes & retraits"/>
    <VerificationBanner/>
    {error && <ErrorState title="Action impossible" text={error}/>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {operatorData.data && <Card className="card-success stack"><SectionTitle icon={Wallet} title="Recette de mon activité"/>
      <div className="grid grid-3">
        <StatCard label="Disponible" value={fcfa(operatorData.data.summary.available)} tone="success"/>
        <StatCard label="En attente" value={fcfa(operatorData.data.summary.reserved)}/>
        <StatCard label="Déjà versé" value={fcfa(operatorData.data.summary.paid)}/>
      </div>
      {operatorData.data.summary.verificationStatus!=='verified' && <p className="small" role="status">Les retraits s’ouvriront dès la validation de votre dossier.</p>}
      <div className="between wrap">
        <label className="grow">Montant du retrait (FCFA)<input className="control" type="number" min={1} step={1} value={opAmount} onChange={e=>setOpAmount(e.target.value)}/></label>
        <label className="grow">Numéro Mobile Money<input className="control" type="tel" inputMode="numeric" value={opPhone} onChange={e=>setOpPhone(e.target.value.replace(/[^0-9]/g,''))}/></label>
        <button className="btn btn-primary" disabled={busy || !online || operatorData.data.summary.verificationStatus!=='verified' || !Number.isInteger(Number(opAmount)) || Number(opAmount)<=0 || !/^[0-9]{8,15}$/.test(opPhone)} onClick={()=>act('/operator/payouts',{amountMinor:Number(opAmount),phoneNumber:opPhone,country:'BJ',network:null},'oppayout-'+crypto.randomUUID())}>Demander le retrait</button>
      </div>
      {(operatorPayouts.data||[]).map(p=><div className="between" key={p.id}><span className="small">{fcfa(p.amountMinor)} · {p.phoneNumber}</span><Badge tone={status('payout',p.status).tone}>{status('payout',p.status).label}</Badge></div>)}
    </Card>}
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
