import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, StatCard, SectionTitle, ApiState } from '@leroutier/ui';
import { createSyncQueue } from '@leroutier/config/offline';
import QrScanner from 'qr-scanner';
import { Users, Route, BusFront, QrCode, AlertTriangle, Wallet, RefreshCw, Package } from 'lucide-react';

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

export function RouteScreen(){
  const {user,request,online}=useSession(),service=useApi(user?'/driver/service':null);
  const s=service.data,manifest=useApi(s?`/services/${s.id}/manifest`:null),cargo=useApi(s?'/driver/parcels':null);
  const queue=useDriverQueue(user?.id,request);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[description,setDescription]=useState(''),[notice,setNotice]=useState(''),[code,setCode]=useState(''),[scanning,setScanning]=useState(false);
  const scanner=useRef(null);
  useEffect(()=>()=>{scanner.current?.stop();scanner.current?.destroy();},[]);
  async function act(type,payload){
    setBusy(true);setError('');setNotice('');
    try{
      // Parcel damage reports are online-only for v1; scans stay queueable offline.
      if(type==='parcel-problem'){
        const description=window.prompt('Décrivez le problème constaté sur le colis :');
        if(!description || !description.trim()) return;
        await request(`/parcels/${payload.id}/exceptions`,{method:'POST',body:{kind:'damaged',description:description.trim()}});
        setNotice('Problème signalé à la régulation.');cargo.reload();
      } else {
        // Manual ticket code: verify online for a clear answer; offline, queue the
        // code itself — the server verifies it during synchronization.
        if(type==='board' && payload.code){
          if(navigator.onLine){
            const result=await request('/tickets/verify',{method:'POST',body:{code:payload.code,serviceId:payload.serviceId,stopSequence:payload.stopSequence}});
            payload={bookingId:result.bookingId,serviceId:payload.serviceId,stopSequence:payload.stopSequence};
          }
        }
        queue.enqueue(type,payload);setNotice('Action enregistrée et synchronisée.');
      }
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
  if(!user || service.loading || service.error || !s) return <><SectionTitle title="Feuille de route & embarquement"/><ApiState resource={service} empty={user?'Aucun service affecté.':'Connectez-vous pour voir votre affectation.'}/></>;
  const stop=s.stops.find(stop=>stop.sequence===s.current_sequence);
  const pending=queue.rows.filter(r=>['pending','syncing','failed'].includes(r.state));
  return <>
    <Card className="card-dark stack"><div className="between wrap"><div><span className="eyebrow">{s.status}</span><h2>{s.route_name}</h2></div><Badge>{s.registration}</Badge></div><strong>Arrêt courant : {stop?.city}</strong></Card>
    <div className="grid grid-3"><StatCard label="À bord" value={manifest.data?.filter(b=>b.status==='boarded').length || 0} icon={Users} tone="success"/><StatCard label="Places véhicule" value={s.capacity} icon={BusFront}/><StatCard label="Arrêt" value={s.current_sequence+1} icon={Route}/></div>
    <Card className="scanner stack"><SectionTitle icon={QrCode} title="Contrôle des billets"/>
      <div className="between"><p className="small">Scannez le QR du billet ou saisissez son code manuel. Les actions s’enregistrent même hors ligne et se synchronisent à la reconnexion.</p>
      {pending.length>0 && <Badge tone="warning"><RefreshCw size={13}/>{pending.length} en attente</Badge>}</div>
      <div className="between wrap">
        <label className="grow">Code du billet<input className="control" placeholder="LRT1.… ou LR-XXXX-XXXX" value={code} onChange={e=>setCode(e.target.value)}/></label>
        <button className="btn btn-primary" disabled={busy || !code.trim()} onClick={()=>act('board',{code:code.trim(),serviceId:s.id,stopSequence:s.current_sequence})}>Valider le billet</button>
        {!scanning?<button className="btn btn-soft" onClick={scan}>Scanner le QR</button>:<button className="btn btn-soft" onClick={()=>{scanner.current?.stop();setScanning(false);}}>Arrêter la caméra</button>}
      </div>
      {scanning && <video id="qr-video" className="qr-video" muted playsInline aria-label="Lecture caméra QR"/>}
      {pending.length>0 && <div className="stack">{pending.map(row=><div className="between wrap" key={row.id}><span className="small">{row.type} · {row.state}{row.error?` · ${row.error}`:''}</span><div>{['failed','conflict'].includes(row.state)&&<button className="btn btn-soft" onClick={()=>row.state==='failed'?queue.retry(row.id):queue.discard(row.id)}>{row.state==='failed'?'Réessayer':'Ignorer'}</button>}</div></div>)}</div>}
      {!online && <button className="btn btn-soft" onClick={queue.sync}>Synchroniser maintenant</button>}
    </Card>
    <SectionTitle icon={Users} title="Manifeste passagers" trailing={<Badge>{stop?.city}</Badge>}/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {manifest.loading || manifest.error || !manifest.data?.length ? <ApiState resource={manifest} empty="Aucun passager confirmé."/> : manifest.data.map(b=><div className="manifest-row" key={b.id}><div className="seat"><small>Siège</small><strong>{b.seat_number}</strong></div><div><h3>{b.passenger_name}</h3><span className="small muted">{b.id}</span><div><Badge tone={b.status==='boarded'?'success':'neutral'}>{b.status}</Badge></div></div>
      {b.status==='confirmed' && b.origin_sequence===s.current_sequence && <button className="btn btn-primary" disabled={busy} onClick={()=>act('board',{bookingId:b.id,serviceId:s.id,stopSequence:s.current_sequence})}>Embarquer</button>}
      {b.status==='boarded' && b.destination_sequence===s.current_sequence && <button className="btn btn-soft" disabled={busy} onClick={()=>act('alight',{bookingId:b.id,serviceId:s.id,stopSequence:s.current_sequence})}>Débarquer</button>}
    </div>)}
    <SectionTitle icon={Package} title="Fret & colis" trailing={cargo.data?.length?<Badge>{cargo.data.length} colis</Badge>:null}/>
    {cargo.loading || cargo.error || !cargo.data?.length ? <ApiState resource={cargo} empty="Aucun colis affecté à ce service."/> : cargo.data.map(p=><Card key={p.id} className="between wrap"><div className="stack"><div className="between"><h3>{p.trackingNumber}</h3><Badge tone={parcelTones[p.status]}>{parcelLabels[p.status]}</Badge></div>
      <span className="small muted">{p.category} · {p.quantity} pièce(s){p.weightG?` · ${p.weightG}g`:''} · destination {p.destinationCity}</span></div>
      <div className="controls">
        {p.status==='manifested' && <button className="btn btn-primary" disabled={busy} onClick={()=>queue.enqueue('parcel',{serviceId:s.id,parcelId:p.id,kind:'loaded'})}>Scanner le chargement</button>}
        {p.status==='loaded' && <button className="btn btn-primary" disabled={busy} onClick={()=>queue.enqueue('parcel',{serviceId:s.id,parcelId:p.id,kind:'departed'})}>Scanner le départ</button>}
        {p.status==='in_transit' && <button className="btn btn-primary" disabled={busy} onClick={()=>queue.enqueue('parcel',{serviceId:s.id,parcelId:p.id,kind:'arrived'})}>Scanner l’arrivée</button>}
        {(p.status==='loaded'||p.status==='in_transit') && <button className="btn btn-soft" disabled={busy || !online} onClick={()=>act('parcel-problem',p)}>Signaler un problème</button>}
      </div></Card>)}
    <Card className="stack"><SectionTitle icon={Wallet} title="Vente au comptant (montée directe)"/>
      <WalkUpForm service={s} onDone={()=>{manifest.reload();service.reload();}}/></Card>
    <Card className="stack"><span className="eyebrow">Actions terrain</span>{s.current_sequence<s.stops.length-1 && <button className="btn btn-primary" disabled={busy} onClick={()=>{setBusy(true);request(`/services/${s.id}/advance`,{method:'POST',body:{sequence:s.current_sequence+1}}).then(()=>{setNotice('Arrêt suivant enregistré.');service.reload();}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>Arrivée à l’arrêt suivant</button>}
      <button className="btn btn-soft" disabled={busy} onClick={()=>navigator.geolocation? navigator.geolocation.getCurrentPosition(p=>request(`/services/${s.id}/positions`,{method:'POST',body:{latitude:p.coords.latitude,longitude:p.coords.longitude,observedAt:new Date(p.timestamp).toISOString()}}).then(()=>setNotice('Position partagée.')).catch(e=>setError(e.message)),()=>setError('Position indisponible ou autorisation refusée.')):setError('Géolocalisation indisponible.')}>Partager ma position</button>
    </Card>
    <Card className="stack"><SectionTitle icon={AlertTriangle} title="Signaler un incident"/><form className="stack" onSubmit={async e=>{e.preventDefault();queue.enqueue('incident',{serviceId:s.id,kind:'other',severity:'medium',description:description.trim()});setDescription('');setNotice('Incident enregistré.');if(navigator.onLine)queue.sync();}}><label>Description<textarea className="control" value={description} onChange={e=>setDescription(e.target.value)} maxLength={2000} required/></label><button className="btn btn-danger" disabled={busy || !description.trim()}>Enregistrer l’incident</button></form></Card>
  </>;
}

// Walk-up cash sales: the only cash channel, restricted to crew on the
// assigned service. The passenger app never accepts cash.
function WalkUpForm({service,onDone}){
  const {request,online}=useSession();
  const [origin,setOrigin]=useState(''),[destination,setDestination]=useState(''),[name,setName]=useState(''),[phone,setPhone]=useState(''),[amount,setAmount]=useState(''),[reference,setReference]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  async function submit(e){
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      const result=await request('/driver/walk-up-bookings',{method:'POST',key:'walkup-'+crypto.randomUUID(),body:{serviceId:service.id,
        origin:Number(origin),destination:Number(destination),passengerName:name,passengerPhone:phone,amountMinor:Number(amount),cashReference:reference.trim()}});
      setNotice(`Vente enregistrée — ${result.amountMinor.toLocaleString('fr-FR')} FCFA encaissés (recette opérateur).`);setName('');setPhone('');setAmount('');setReference('');onDone?.();
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  const stops=service.stops||[];
  return <form className="stack" onSubmit={submit}>
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
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </form>;
}

const payoutLabels={requested:'Demandé',processing:'En cours',paid:'Versé',failed:'Échoué',cancelled:'Annulé',reversed:'Annulé (reversé)'};
const payoutTones={requested:'neutral',processing:'neutral',paid:'success',failed:'danger',cancelled:'neutral',reversed:'danger'};

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
  return <>
    <SectionTitle icon={Wallet} title="Mes gains & versements"/>
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
  return <><Card className="stack"><h2>{user?.display_name || 'Profil conducteur'}</h2><span className="small muted">Compte conducteur</span></Card><Card className="stack"><SectionTitle icon={BusFront} title="Affectation véhicule"/>{service.data?<><h3>{service.data.registration}</h3><p>{service.data.route_name}</p><Badge>{service.data.capacity} places</Badge></>:<ApiState resource={service} empty="Aucune affectation disponible."/>}</Card></>;
}
