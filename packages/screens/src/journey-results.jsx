import { Suspense,lazy,useEffect,useRef,useMemo,useState } from 'react';
import { useSearchParams } from 'react-router';
import { useApi,useSession } from '@leroutier/config/client';
import { Card,Badge,ErrorState,SkeletonCards } from '@leroutier/ui';
import { fcfa,time,dayLong } from '@leroutier/ui';
import { Armchair,Bus,Car,List,Map as MapIcon,X,ShieldCheck,Star,UserRound } from 'lucide-react';
import './operator-trust.css';

const JourneyMap=lazy(()=>import('./map.jsx').then(m=>({default:m.JourneyPlanMap})));
export function TestBadge(){return <Badge tone="danger">TEST</Badge>;}
export function ModeTestBanner(){return <div className="notice test-mode-banner" role="status"><strong>Mode test</strong> : Ces trajets sont fictifs et servent uniquement à tester LeRoutier. Aucun paiement réel ne sera effectué.</div>;}
const km=metres=>Number.isFinite(metres)?`${Math.round(metres/100)/10} km`:null;
const mins=seconds=>Number.isFinite(seconds)?`${Math.round(seconds/60)} min`:null;
const durText=seconds=>Number.isFinite(seconds)?`${Math.floor(seconds/3600)} h ${String(Math.round((seconds%3600)/60)).padStart(2,'0')}`:null;
const vehicleText=vehicle=>[vehicle?.make,vehicle?.model,vehicle?.color,vehicle?.year].filter(Boolean).join(' · ')||'Véhicule non communiqué';

function IndependentTrust({option,compact=false}){
  if(option.operatorType!=='independent')return null;
  const driver=option.driver??{};
  return <div className={`independent-trust ${compact?'compact':''}`}>
    {driver.photoUrl?<img className="driver-photo" src={driver.photoUrl} alt={`Photo de ${driver.name||'votre chauffeur'}`} referrerPolicy="no-referrer"/>:<div className="driver-photo placeholder" aria-label="Photo du chauffeur non disponible"><UserRound size={24}/></div>}
    <div className="driver-trust-copy">
      <div className="between wrap"><strong>{driver.name||option.operatorName}</strong>{option.verified&&<Badge tone="success"><ShieldCheck size={13}/>Vérifié par LeRoutier</Badge>}</div>
      <span className="small muted">Chauffeur indépendant</span>
      <div className="vehicle-identity"><Car size={15}/><span>{vehicleText(option.vehicle)}</span></div>
      <strong className="vehicle-registration">{option.vehicle?.registration||'Immatriculation non communiquée'}</strong>
    </div>
  </div>;
}

// What an operator's past passengers said, and what the operator says about
// its coach. Both are attributed: the rating is other travellers' opinion,
// the amenities are the operator's own claim. Neither is a LeRoutier promise,
// and the wording keeps that distinction visible.
function Reputation({rating}){
  if(!rating)return null;
  if(!rating.published)return <span className="small muted offer-rating">
    {rating.count?`${rating.count} avis · pas encore de moyenne`:'Pas encore d’avis'}</span>;
  return <span className="offer-rating" title={`Moyenne de ${rating.count} avis de voyageurs`}>
    <Star size={13} aria-hidden="true"/><strong>{rating.average.toLocaleString('fr-FR',{minimumFractionDigits:1})}</strong>
    <span className="small muted">({rating.count} avis)</span></span>;
}

function Amenities({amenities,limit=4}){
  if(!amenities?.length)return null;
  const shown=amenities.slice(0,limit),rest=amenities.length-shown.length;
  return <div className="offer-amenities" aria-label="Équipements annoncés par l’opérateur">
    {shown.map(a=><span key={a.key} className="amenity-tag">{a.short}</span>)}
    {rest>0&&<span className="amenity-tag more">+{rest}</span>}</div>;
}

function OperatorLine({option}){
  const independent=option.operatorType==='independent';
  if(independent)return <IndependentTrust option={option} compact/>;
  // A company service leads with the verified company, and still names the
  // vehicle: a passenger waiting at a gare routière recognises the bus they
  // booked by its model and its plate. What a company service never publishes
  // is the employee driving it — that is staff surveillance, not a product
  // feature, and the API withholds it.
  return <div className="offer-operator-block">
    <div className="offer-operator"><Bus size={14}/><span>Compagnie</span><strong>{option.operatorName}</strong>{option.verified&&<Badge tone="success"><ShieldCheck size={13}/>Vérifiée</Badge>}</div>
    <div className="vehicle-identity"><Car size={15}/><span>{vehicleText(option.vehicle)}</span>
      {option.vehicle?.registration&&<strong className="vehicle-registration">{option.vehicle.registration}</strong>}</div>
  </div>;
}

export function OfferCard({option,originLabel,destinationLabel,selected,onSelect,onView,onChoose,compact=false}){
  const seats=option.available,soldOut=seats===0;
  return <article className={`card offer-card ${selected?'selected':''} ${compact?'compact':''}`} onMouseEnter={onSelect} onFocusCapture={onSelect} aria-label={`Trajet de ${option.operatorName}`}>
    <div className="offer-head between wrap"><div className="trip-times"><strong>{time(option.departureAt)}</strong><span className="arrow">→</span><strong>{option.etaAt?time(option.etaAt):'–'}</strong>{option.totalDurationS!=null&&<span className="trip-duration">{durText(option.totalDurationS)}</span>}</div>
      <div className="offer-head-end">{option.isTest&&<TestBadge/>}<Badge tone={soldOut?'danger':seats>2?'success':'warning'}><Armchair size={13}/>{soldOut?'Complet':`${seats} place${seats>1?'s':''}`}</Badge></div></div>
    <div className="offer-journey"><div className="offer-line"><span className="offer-dot start"/><div><strong>{originLabel??option.pickupStop.city}</strong>{option.firstMile&&<span className="small muted"> · Premier kilomètre : {mins(option.firstMile.durationS)} · {km(option.firstMile.distanceM)}</span>}</div></div><div className="offer-rail"/><div className="offer-line"><span className="offer-dot end"/><div><strong>{destinationLabel??option.dropoffStop.city}</strong>{option.lastMile&&<span className="small muted"> · Dernier kilomètre : {mins(option.lastMile.durationS)} · {km(option.lastMile.distanceM)}</span>}</div></div></div>
    <p className="small muted">Montée : {option.pickupStop.name} · Descente : {option.dropoffStop.name}</p>
    <OperatorLine option={option}/>
    <div className="between wrap offer-trust"><Reputation rating={option.rating}/><Amenities amenities={option.amenities}/></div>
    <span className="small muted">{option.serviceStatus==='active'?'En cours':'Départ programmé'}{option.livePosition?` · ${option.livePosition.signal==='live'?'En direct':'Dernière position connue'}`:''}</span>
    {option.waitingS>0&&<span className="small muted">Dont {mins(option.waitingS)} d’attente à la prise en charge</span>}
    <div className="trip-foot"><span className="trip-price">{fcfa(option.fare.amountMinor)}</span><div className="controls"><button className="btn btn-soft" onClick={onView}>Voir le trajet</button><button className="btn btn-primary" disabled={soldOut||!option.feasible} onClick={onChoose}>Choisir</button></div></div>
  </article>;
}

function OfferDetails({option,originLabel,destinationLabel,originPoint,destinationPoint,onClose,onChoose}){
  const seats=option.available,soldOut=seats===0,dialog=useRef(null);
  useEffect(()=>{const previous=document.activeElement;dialog.current.showModal();return()=>{if(previous instanceof HTMLElement)previous.focus();};},[]);
  const leaveOrigin=new Date(new Date(option.departureAt).getTime()-(option.firstMile?.durationS??0)*1000-option.waitingS*1000);
  const arrivePickup=new Date(new Date(option.departureAt).getTime()-option.waitingS*1000),steps=[];
  if(option.firstMile){steps.push([time(leaveOrigin.toISOString()),`${originLabel??'Votre position'} : départ`]);steps.push([time(arrivePickup.toISOString()),`Arrivée au point de prise en charge · ${option.pickupStop.name}`]);}
  steps.push([time(option.departureAt),`Départ LeRoutier · ${option.pickupStop.city} → ${option.dropoffStop.city}`]);
  for(const stop of(option.intermediateStops??[]).filter(s=>s.sequence>option.originSequence&&s.sequence<option.destinationSequence))steps.push([null,`Arrêt · ${stop.city}`]);
  steps.push([time(option.intercity.etaAt),`Arrivée ${option.dropoffStop.city}`]);if(option.lastMile)steps.push([time(option.etaAt),`Destination finale · ${destinationLabel??'votre destination'}`]);
  return <dialog ref={dialog} className="offer-details" aria-label="Détails du trajet" onCancel={onClose}>
    <div className="offer-details-head between"><div><strong>{originLabel??option.pickupStop.city} → {destinationLabel??option.dropoffStop.city}</strong><span className="small muted"> · {dayLong(option.departureAt)} · {durText(option.totalDurationS)} au total</span></div><button className="icon-btn" aria-label="Fermer les détails" onClick={onClose}><X size={17}/></button></div>
    {option.isTest&&<div className="offer-details-test"><TestBadge/> <span className="small">Offre de démonstration : aucun transport réel.</span></div>}
    <OperatorLine option={option}/>
    {option.operatorType==='independent'&&<Card className="stack independent-detail"><h3>Votre chauffeur et son véhicule</h3><IndependentTrust option={option}/>{option.vehicle?.photoUrl&&<img className="vehicle-photo" src={option.vehicle.photoUrl} alt={`${option.vehicle.make??''} ${option.vehicle.model??'Véhicule du chauffeur'}`.trim()} referrerPolicy="no-referrer"/>}<p className="small muted">Les documents d’identité, permis, assurance et autres justificatifs restent privés. Seules les informations utiles pour reconnaître le chauffeur et le véhicule sont affichées.</p></Card>}
    <div className="journey-steps">{steps.map(([at,label],i)=><div key={i} className="journey-step">{at?<strong className="small">{at}</strong>:<span className="small muted">–</span>}<span className="small">{label}</span></div>)}</div>
    {option.livePosition&&<span className="small muted" role="status">{option.livePosition.signal==='live'?'En direct : position récente du véhicule':'Dernière position connue du véhicule'}</span>}
    <Suspense fallback={<SkeletonCards count={1} lines={3}/>}><JourneyMap option={option} originPoint={originPoint} destinationPoint={destinationPoint} height={260}/></Suspense>
    <div className="summary"><div className="row"><span>Opérateur</span><span>{option.operatorName}</span></div><div className="row"><span>Véhicule</span><span>{vehicleText(option.vehicle)}</span></div><div className="row"><span>Immatriculation</span><span>{option.vehicle?.registration??'Non communiquée'}</span></div><div className="row"><span>Places restantes</span><span>{soldOut?'Complet':`${seats} place${seats>1?'s':''}`}</span></div><div className="row"><span>Prix final</span><span>{fcfa(option.fare.amountMinor)}</span></div></div>
    <p className="small muted">Transport local (premier et dernier kilomètre) non inclus : estimé à pied. Conditions d’annulation selon l’opérateur.</p>
    <div className="controls"><button className="btn btn-soft" onClick={onClose}>Fermer</button><button className="btn btn-primary" disabled={soldOut||!option.feasible} onClick={onChoose}>Choisir ce trajet</button></div>
  </dialog>;
}

const SORTS=[['recommended','Recommandé'],['earliest','Départ le plus tôt'],['arrival','Arrivée la plus tôt'],['cheapest','Prix le plus bas'],['shortest','Durée la plus courte']];
const FILTERS=[['all','Tout'],['company','Compagnies'],['independent','Chauffeurs indépendants'],['seats','≥ 2 places'],['direct','Direct']];

export function JourneySearchResults({originMode,originPlace,destinationPlace,destinationStopId,day,choose,onEditDate,onEditOrigin,onEditDestination,originPoint,destinationPoint,position,geoState,geoError,onLocate}){
  const {user,online}=useSession(),[params]=useSearchParams(),places=useApi('/places?type=commune');
  const [sort,setSort]=useState('recommended'),[filter,setFilter]=useState('all'),[view,setView]=useState('list'),[selected,setSelected]=useState(null),[detail,setDetail]=useState(null);
  const destinationKey=destinationStopId?`destinationStopId=${destinationStopId}`:`destinationPlaceId=${destinationPlace}`;
  const baseUrl=originMode==='current'&&position?`/journey-plan?lat=${position.latitude}&lon=${position.longitude}&${destinationKey}`:originMode==='place'&&originPlace?`/journey-plan?originPlaceId=${originPlace}&${destinationKey}`:null;
  const planUrl=baseUrl?baseUrl+`&departureAt=${encodeURIComponent(day+'T00:00:00+01:00')}`+(params.get('testMode')==='1'?'&testMode=1':''):null,plan=useApi(planUrl);
  const nameOf=id=>(places.data||[]).find(p=>p.id===id)?.name??null,originLabel=nameOf(originPlace)??plan.data?.options?.[0]?.pickupStop?.city??null,destinationLabel=nameOf(destinationPlace)??plan.data?.options?.[0]?.dropoffStop?.city??null;
  const options=useMemo(()=>{let list=(plan.data?.options||[]).filter(o=>!day||(o.departureAt&&new Date(o.departureAt).toLocaleDateString('en-CA')===day));if(filter==='company')list=list.filter(o=>o.operatorType==='company');else if(filter==='independent')list=list.filter(o=>o.operatorType==='independent');else if(filter==='seats')list=list.filter(o=>o.available>=2);else if(filter==='direct')list=list.filter(o=>!o.firstMile&&!o.lastMile);const by={recommended:(a,b)=>(Number(b.feasible)-Number(a.feasible))||((a.totalDurationS??Infinity)-(b.totalDurationS??Infinity)),earliest:(a,b)=>Date.parse(a.departureAt)-Date.parse(b.departureAt),arrival:(a,b)=>(a.etaAt?Date.parse(a.etaAt):Infinity)-(b.etaAt?Date.parse(b.etaAt):Infinity),cheapest:(a,b)=>a.fare.amountMinor-b.fare.amountMinor,shortest:(a,b)=>(a.totalDurationS??Infinity)-(b.totalDurationS??Infinity)}[sort];return [...list].sort(by);},[plan.data,day,sort,filter]);
  const anyTest=options.some(o=>o.isTest),shown=detail??options.find(o=>o.serviceId===selected?.serviceId&&o.originSequence===selected?.originSequence&&o.destinationSequence===selected?.destinationSequence)??options[0];
  return <div className="stack journey-results">
    {originMode==='current'&&position===null&&<div className="controls"><button className="btn btn-primary" disabled={geoState==='asking'} onClick={onLocate}>{geoState==='asking'?'Localisation en cours…':'Utiliser ma position actuelle'}</button>{geoError&&<p className="small muted" role="status">{geoError}</p>}</div>}
    {planUrl&&(plan.loading?<><p role="status">Recherche des trajets…</p><SkeletonCards count={2} lines={4}/></>:plan.error?<ErrorState text="Impossible de calculer votre trajet pour le moment." onRetry={plan.reload}/>:<div className="journey-results-grid"><div className="journey-offers stack">
      <Card className="stack results-summary"><div className="search-summary between wrap"><div><h2>{originLabel??'Départ'} → {destinationLabel??'Destination'}</h2><span className="small muted">{dayLong(day)} · 1 voyageur</span></div><button className="btn btn-soft" onClick={onEditDate}>Modifier</button></div>{options.length>0&&<><div className="between wrap"><label className="field">Trier<select className="control" aria-label="Trier les trajets" value={sort} onChange={e=>setSort(e.target.value)}>{SORTS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><span className="small muted" role="status">{options.length} trajet{options.length>1?'s':''} disponible{options.length>1?'s':''}</span></div><div className="filter-chips" role="group" aria-label="Filtrer les trajets">{FILTERS.map(([value,label])=><button key={value} type="button" className={`chip ${filter===value?'active':''}`} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div></>}{(anyTest||plan.data?.includeDemo)&&<ModeTestBanner/>}</Card>
      {/* The picture says what the words say: the road is real, nothing is
          running on it yet. It is decoration only in the sense that a person
          who searched and found nothing deserves something warmer than three
          grey buttons — the recovery actions underneath are still the point.
          aria-hidden because the <strong> below already states the outcome;
          announcing it twice helps nobody. */}
      {!options.length?<Card className="stack"><img className="empty-illustration" src="/empty-route.svg" alt="" aria-hidden="true" width="480" height="190" loading="lazy"/><strong>Aucun départ disponible pour cet itinéraire pour le moment.</strong><p className="small muted">Ce trajet n’est pas encore desservi. Vous pouvez modifier la date, le départ ou la destination.</p><div className="controls"><button className="btn btn-soft" onClick={onEditDate}>Modifier la date</button><button className="btn btn-soft" onClick={onEditOrigin}>Modifier le départ</button><button className="btn btn-soft" onClick={onEditDestination}>Modifier la destination</button></div></Card>:<><div className="list-map-toggle" role="group" aria-label="Affichage liste ou carte"><button className={`chip ${view==='list'?'active':''}`} aria-pressed={view==='list'} onClick={()=>setView('list')}><List size={14}/>Liste</button><button className={`chip ${view==='map'?'active':''}`} aria-pressed={view==='map'} onClick={()=>setView('map')}><MapIcon size={14}/>Carte</button></div>
      {!detail&&view==='map'&&shown&&<Card className="stack map-full"><OfferCard option={shown} originLabel={originLabel} destinationLabel={destinationLabel} compact selected onSelect={()=>{}} onView={()=>setDetail(shown)} onChoose={()=>choose(shown)}/><Suspense fallback={<SkeletonCards count={1} lines={4}/>}><JourneyMap option={shown} originPoint={originPoint} destinationPoint={destinationPoint} height={420}/></Suspense>{options.length>1&&<div className="offer-pager" role="list">{options.map(o=><button key={o.serviceId+':'+o.originSequence+':'+o.destinationSequence} role="listitem" type="button" className={`offer-pager-dot ${selected?.serviceId===o.serviceId&&selected?.originSequence===o.originSequence?'active':''}`} aria-label={`Afficher le trajet de ${o.operatorName} à ${time(o.departureAt)}`} onClick={()=>setSelected(o)}/>)}</div>}</Card>}
      {!detail&&view==='list'&&options.map(o=><OfferCard key={o.serviceId+':'+o.originSequence+':'+o.destinationSequence} option={o} originLabel={originLabel} destinationLabel={destinationLabel} selected={selected?.serviceId===o.serviceId&&selected?.originSequence===o.originSequence} onSelect={()=>setSelected(o)} onView={()=>setDetail(o)} onChoose={()=>choose(o)}/>)}</>}
    </div>{!detail&&view==='list'&&shown&&options.length>0&&<div className="journey-map-col"><Suspense fallback={<SkeletonCards count={1} lines={5}/>}><JourneyMap option={shown} originPoint={originPoint} destinationPoint={destinationPoint} height={560}/></Suspense></div>}</div>)}
    {detail&&<OfferDetails option={detail} originLabel={originLabel} destinationLabel={destinationLabel} originPoint={originPoint} destinationPoint={destinationPoint} onClose={()=>setDetail(null)} onChoose={()=>{const o=detail;setDetail(null);choose(o);}}/>}
    {user&&!online&&<p className="small muted" role="status">Hors ligne : les actions nécessitent une connexion.</p>}
  </div>;
}
