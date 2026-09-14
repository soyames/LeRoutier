import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, SectionTitle, ApiState } from '@leroutier/ui';
import { Armchair, Ticket, Building2, Navigation, UserRound, Route } from 'lucide-react';

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
        <button className="btn btn-primary" disabled={!user || !online || !!busy || !service.availability.available} onClick={()=>book(service)}>{busy===service.id?'Réservation…':'Réserver une place'}</button></div>
      {service.is_demo && <span className="small muted">Service de démonstration</span>}
    </Card>)}
  </>;
}

export function Tickets() {
  const {user,request,online}=useSession(),bookings=useApi(user?'/me/bookings':null);
  const [error,setError]=useState(''),[busy,setBusy]=useState('');
  async function action(id,verb){setBusy(id);setError('');try{await request(`/bookings/${id}/${verb}`,{method:'POST'});bookings.reload();}catch(e){setError(e.message);}finally{setBusy('');}}
  const labels={held:'Option en attente de paiement',confirmed:'Confirmé',boarded:'À bord',completed:'Terminé',cancelled:'Annulé',expired:'Option expirée'};
  return <><SectionTitle icon={Ticket} title="Mes billets"/>{error && <p role="alert">{error}</p>}
    {!user || bookings.loading || bookings.error || !bookings.data?.length ? <ApiState resource={bookings} empty={user?'Aucune réservation.':'Connectez-vous pour retrouver vos billets.'}/> : bookings.data.map(b=><Card key={b.id} className="ticket">
      <div className="ticket-head between"><h2>{b.route_name}</h2><Badge>{labels[b.status]}</Badge></div><div className="ticket-body stack">
        <div className="between"><span>{new Date(b.departure_at).toLocaleString('fr-FR')}</span><strong>Siège {b.seat_number}</strong></div>
        <span className="small">Référence : {b.id}</span><div className="price">{b.amount_minor.toLocaleString('fr-FR')} FCFA</div>
        {b.status==='held' && <><p className="small">Option jusqu’au {new Date(b.expires_at).toLocaleTimeString('fr-FR')}. Le paiement doit être enregistré par un agent autorisé avant confirmation.</p><button className="btn btn-primary" disabled={!!busy || !online} onClick={()=>action(b.id,'confirm')}>Vérifier le paiement et confirmer</button></>}
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
  const {user}=useSession();return <><SectionTitle icon={UserRound} title="Mon compte"/><Card className="stack">{user?<><h2>{user.display_name}</h2><Badge tone="success">Compte connecté</Badge><p className="small muted">Vos billets et réservations sont synchronisés avec le service.</p></>:<p>Connectez-vous pour accéder à votre compte.</p>}</Card></>;
}
