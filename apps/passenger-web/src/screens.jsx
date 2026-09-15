import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, SectionTitle, ApiState, ProfileForm } from '@leroutier/ui';
import { QRCodeSVG } from 'qrcode.react';
import { Armchair, Ticket, Building2, Navigation, UserRound, Route, CreditCard } from 'lucide-react';

export function Trips() {
  const routes=useApi('/routes'),{user,request,online}=useSession(),navigate=useNavigate();
  const [origin,setOrigin]=useState(''),[destination,setDestination]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState('');
  const keys=useRef(new Map());
  const stops=routes.data?.[0]?.stops || [];
  const from=origin || stops[0]?.stopId,to=destination || stops.at(-1)?.stopId;
  const services=useApi(from && to?`/services?originStopId=${from}&destinationStopId=${to}`:null);
  async function book(service) {
    const quote=service.availability,identity=[service.id,quote.origin,quote.destination].join(':');
    if(!keys.current.has(identity)) keys.current.set(identity,crypto.randomUUID());
    setBusy(service.id);setError('');
    try {
      await request('/bookings',{method:'POST',key:keys.current.get(identity),body:{serviceId:service.id,origin:quote.origin,destination:quote.destination}});
      keys.current.delete(identity);navigate('/tickets');
    } catch(e){setError(e.message);} finally{setBusy('');services.reload();}
  }
  return <>
    <Card className="hero stack"><span className="eyebrow">Recherche de trajet</span><h1>Voyagez entre les villes du Bénin, simplement.</h1><p>Disponibilité et prix calculés par tronçon. Les places libérées à un arrêt sont réutilisables pour la suite du trajet.</p></Card>
    {routes.loading || routes.error || !stops.length ? <ApiState resource={routes} empty="Aucune ligne ouverte actuellement."/> : <Card className="stack"><div className="search-panel">
      <label className="search-place">Départ<select className="control" aria-label="Départ" value={from} onChange={e=>setOrigin(e.target.value)}>{stops.map(s=><option key={s.stopId} value={s.stopId}>{s.city} · {s.name}</option>)}</select></label>
      <Route size={20}/><label className="search-place end">Arrivée<select className="control" aria-label="Arrivée" value={to} onChange={e=>setDestination(e.target.value)}>{stops.map(s=><option key={s.stopId} value={s.stopId}>{s.city} · {s.name}</option>)}</select></label>
    </div><span className="small muted">1 passager par réservation · tarif en FCFA</span></Card>}
    <SectionTitle title="Départs disponibles"/>
    {error && <p role="alert">{error}</p>}
    {services.loading || services.error || !services.data?.length ? <ApiState resource={services} empty="Aucun départ pour ce trajet."/> : services.data.map(service=><Card key={service.id} className="route-card">
      <div className="between"><div><h3>{service.operator_name}</h3><span className="small muted">{service.registration}</span></div><div className="price">{service.availability.fare.amountMinor.toLocaleString('fr-FR')} FCFA</div></div>
      <div className="route-line"><div><strong>{service.availability.stops[service.availability.origin].city}</strong></div><div className="mid"><span className="small muted">{new Date(service.departure_at).toLocaleString('fr-FR')}</span><div className="track"/></div><strong>{service.availability.stops[service.availability.destination].city}</strong></div>
      <div className="between wrap"><Badge tone={service.availability.available?'success':'danger'}><Armchair size={13}/>{service.availability.available} places</Badge>
        <button className="btn btn-primary" disabled={!user || user.needs_profile || !online || !!busy || !service.availability.available} onClick={()=>book(service)}>{busy===service.id?'Réservation…':'Réserver une place'}</button></div>
      {service.is_demo && <span className="small muted">Service de démonstration</span>}
    </Card>)}
  </>;
}

export function Tickets() {
  const {user,request,online}=useSession(),bookings=useApi(user?'/me/bookings':null);
  const paymentsConfig=useApi('/payments/config');
  const [error,setError]=useState(''),[busy,setBusy]=useState(''),[tickets,setTickets]=useState({}),[payStates,setPayStates]=useState({});
  const onlinePayments=paymentsConfig.data?.available===true;
  // After a FedaPay redirect the passenger returns to the app: poll the trusted
  // server state — the booking only becomes confirmed after reconciliation.
  const dataRef=useRef(bookings.data),reloadRef=useRef(bookings.reload);
  useEffect(()=>{dataRef.current=bookings.data;reloadRef.current=bookings.reload;});
  const heldKey=(bookings.data||[]).filter(b=>b.status==='held').map(b=>b.id).sort().join(',');
  useEffect(()=>{
    if(!user || !heldKey) return;
    let cancelled=false;
    const timer=setInterval(async()=>{
      try{
        for(const b of (dataRef.current||[]).filter(x=>x.status==='held')){
          const payments=await request(`/bookings/${b.id}/payment-status`);
          const state=payments.some(p=>p.status==='succeeded')?'succeeded'
            :payments.some(p=>p.status==='pending')?'pending'
            :payments.some(p=>p.status==='failed'||p.status==='cancelled')?'failed':'none';
          if(!cancelled) setPayStates(prev=>({...prev,[b.id]:state}));
        }
        reloadRef.current();
      }catch{/* transient polling failures stay silent */}
    },5000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[user,heldKey,request]);
  async function action(id,verb){setBusy(id);setError('');try{await request(`/bookings/${id}/${verb}`,{method:'POST'});bookings.reload();}catch(e){setError(e.message);}finally{setBusy('');}}
  async function pay(id){setBusy(id);setError('');
    try{
      const intent=await request(`/bookings/${id}/payment-intents`,{method:'POST',key:'pay-'+id,body:{}});
      setPayStates(prev=>({...prev,[id]:'pending'}));
      // Redirect to the hosted FedaPay page. Return URLs are UX only: only the
      // verified provider webhook can confirm the booking.
      if(intent.checkoutUrl) window.location.assign(intent.checkoutUrl);
      else setError('Le lien de paiement est indisponible. Réessayez.');
    }catch(e){if(e.code==='PAYMENT_UNAVAILABLE')setError('Le paiement en ligne n’est pas disponible pour le moment.');else setError(e.message);}
    finally{setBusy('');}}
  async function issue(id){setBusy(id);setError('');
    try{const t=await request(`/bookings/${id}/ticket`,{method:'POST',body:{}});setTickets(prev=>({...prev,[id]:t}));}
    catch(e){setError(e.message);}finally{setBusy('');}}
  const labels={held:'Option en attente de paiement',confirmed:'Confirmé',boarded:'À bord',completed:'Terminé',cancelled:'Annulé',expired:'Option expirée'};
  return <><SectionTitle icon={Ticket} title="Mes billets"/>{error && <p role="alert">{error}</p>}
    {!user || bookings.loading || bookings.error || !bookings.data?.length ? <ApiState resource={bookings} empty={user?'Aucune réservation.':'Connectez-vous pour retrouver vos billets.'}/> : bookings.data.map(b=><Card key={b.id} className="ticket">
      <div className="ticket-head between"><h2>{b.route_name}</h2><Badge>{labels[b.status]}</Badge></div><div className="ticket-body stack">
        <div className="between"><span>{new Date(b.departure_at).toLocaleString('fr-FR')}</span><strong>Siège {b.seat_number}</strong></div>
        <span className="small">Référence : {b.id}</span><div className="price">{b.amount_minor.toLocaleString('fr-FR')} FCFA</div>
        {b.status==='held' && <div className="payment-box stack">
          <div className="between"><Badge tone={payStates[b.id]==='pending'?'neutral':'danger'}><CreditCard size={13}/>{payStates[b.id]==='pending'?'Paiement en attente…':payStates[b.id]==='failed'?'Paiement refusé ou annulé':payStates[b.id]==='succeeded'?'Paiement vérifié':'Paiement requis'}</Badge>
          <span className="small muted">Option jusqu’au {new Date(b.expires_at).toLocaleTimeString('fr-FR')}</span></div>
          {payStates[b.id]==='succeeded'
            ? <button className="btn btn-primary" disabled={!!busy || !online} onClick={()=>action(b.id,'confirm')}>Confirmer la réservation</button>
            : onlinePayments
              ? <button className="btn btn-primary" disabled={!!busy || !online} onClick={()=>pay(b.id)}>{busy===b.id?'Connexion au paiement…':payStates[b.id]==='failed'?'Réessayer le paiement':'Payer en ligne'}</button>
              : <p role="status">Le paiement en ligne n’est pas disponible pour le moment. Votre option expirera automatiquement — aucun billet ne peut être émis sans paiement vérifié.</p>}
          {payStates[b.id]==='pending' && <p className="small muted">Paiement en cours chez FedaPay. La confirmation apparaît dès réception du paiement — actualisation automatique.</p>}
        </div>}
        {['confirmed','boarded'].includes(b.status) && !tickets[b.id] && <button className="btn btn-primary" disabled={!!busy || !online} onClick={()=>issue(b.id)}>Obtenir mon billet (QR)</button>}
        {tickets[b.id] && <div className="qr-box stack"><div className="between"><h3>Billet valide</h3><Badge tone="success">Version {tickets[b.id].version}</Badge></div>
          <div className="qr-canvas"><QRCodeSVG value={tickets[b.id].token} size={168} marginSize={1}/></div>
          <span className="small muted">Code manuel : <strong>{tickets[b.id].manualCode}</strong></span>
          <span className="small">Valable jusqu’au {new Date(tickets[b.id].expiresAt).toLocaleString('fr-FR')}. Présentez ce QR au contrôleur à l’embarquement.</span>
          <span className="small muted">Récupérer à nouveau remplace l’ancien code.</span></div>}
        {['held','confirmed'].includes(b.status) && <button className="btn btn-soft" disabled={!!busy || !online} onClick={()=>action(b.id,'cancel')}>Annuler la réservation</button>}
      </div></Card>)}
  </>;
}
export function Stations(){
  const stops=useApi('/stops');
  return <><SectionTitle icon={Building2} title="Gares & points d'arrêt"/>{stops.loading || stops.error || !stops.data?.length ? <ApiState resource={stops}/> : stops.data.map(s=><Card key={s.id} className="stack"><h3>{s.city} · {s.name}</h3><p className="small muted">Point d’arrêt du réseau LeRoutier</p>{s.latitude!==null && <span className="small">{s.latitude}, {s.longitude}</span>}</Card>)}</>;
}
export function Tracking(){
  const {user}=useSession(),bookings=useApi(user?'/me/bookings':null);
  const booking=bookings.data?.find(b=>['confirmed','boarded'].includes(b.status));
  const position=useApi(booking?`/services/${booking.service_id}/positions`:null);
  return <><SectionTitle icon={Navigation} title="Suivi de mon trajet"/>{!booking || !position.data ? <ApiState resource={booking?position:bookings} empty="Aucune position disponible pour un billet actif."/> : <Card className="stack"><h2>{booking.route_name}</h2><p>Dernière position : {position.data.latitude}, {position.data.longitude}</p><span className="small muted">Observée le {new Date(position.data.observed_at).toLocaleString('fr-FR')}</span><button className="btn btn-soft" onClick={position.reload}>Actualiser</button></Card>}</>;
}
export function Account(){
  const {user}=useSession();return <><SectionTitle icon={UserRound} title="Mon compte"/><Card className="stack">{user?<><h2>{user.display_name}</h2><Badge tone="success">Compte connecté</Badge>{!user.needs_profile && <ProfileForm/>}<p className="small muted">Vos billets et réservations sont synchronisés avec le service.</p></>:<p>Connectez-vous pour accéder à votre compte.</p>}</Card></>;
}
