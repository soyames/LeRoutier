import { Suspense, lazy, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, StatCard, SectionTitle, ApiState, ErrorState, SkeletonCards } from '@leroutier/ui';
import { status, fcfa } from '@leroutier/ui';
import { Provisioning } from './provisioning.jsx';
// Leaflet loads only when an operator actually opens a map.
const TransportMap = lazy(() => import('./map.jsx'));
import { BusFront, Armchair, Radio, ShieldAlert, WalletCards, ShieldCheck, Package, MapPin, Home, Users, Check } from 'lucide-react';

// Ops screens are mounted at /ops/* in the unified app and at /* in the legacy
// operations app: setup links resolve against whichever prefix is in use.
function useOpsLink() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const prefix = pathname.startsWith('/ops') ? '/ops' : '';
  return path => navigate(`${prefix}${path}`);
}


// Automated treatments, named for what they do rather than by their workflow id.
const WORKFLOW_LABELS={
  'payment-reconciliation':'Rapprochement d’un paiement',
  'breakdown-recovery':'Remplacement après panne',
  'driver-payout':'Versement à un conducteur',
  'delay-management':'Gestion d’un retard',
  'parcel-delay':'Colis sur un service retardé',
  'payout-anomaly':'Anomalie de versement',
  'parcel-exception':'Anomalie colis',
  'parcel-breakdown':'Colis après panne',
};

function useOpsActions(){
  const {request}=useSession();
  return async function act(path,body,method='POST',key=undefined,onDone=undefined){
    try{await request(path,{method,body,key});onDone?.();return {ok:true};}
    catch(e){return {ok:false,error:e.message};}
  };
}

export function Today(){
  const {user,online}=useSession();
  const diagnostics=useApi(user?'/ops/diagnostics':null);
  const fleet=useApi(user?'/ops/fleet':null);
  const approvals=useApi(user?'/agent/approvals':null);
  const operatorsList=useApi(user && !user.operator_id?'/operators':null);
  const catalog=useApi(user?'/ops/provisioning':null);
  const stations=useApi(user?.operator_id?`/operators/${user.operator_id}/stations`:null);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  const act=useOpsActions();
  const today=new Date();
  const todayServices=(fleet.data?.services||[]).filter(s=>new Date(s.departure_at).toDateString()===today.toDateString());
  const data=catalog.data;
  const configured=user?.verification_status==='verified';
  const hasOperations=(data?.vehicles?.length>0 || data?.routes?.length>0 || fleet.data?.services?.length>0);
  const go=useOpsLink();
  const checklist=[
    {label:'Enregistrer votre gare ou point de départ',done:(stations.data||[]).length>0,path:'/stations'},
    {label:'Ajouter un véhicule',done:(data?.vehicles||[]).length>0,path:'/fleet'},
    {label:'Ajouter un conducteur',done:(data?.users||[]).some(u=>u.role==='driver'),path:'/crew'},
    {label:'Ajouter un convoyeur (recommandé)',done:(data?.users||[]).some(u=>u.role==='convoyeur'),path:'/crew'},
    {label:'Créer une ligne et ses tarifs',done:(data?.routes||[]).length>0,path:'/services'},
    {label:'Publier votre premier départ',done:(fleet.data?.services||[]).length>0,path:'/services'},
  ];
  const remaining=checklist.filter(step=>!step.done).length;
  async function approve(approvalId,decision){
    const result=await act(`/agent/approvals/${approvalId}`,{decision});
    if(result.ok)setNotice('Décision enregistrée.');else setError(result.error);
    diagnostics.reload();approvals.reload();
  }
  return <>
    <SectionTitle icon={Home} title="Aujourd’hui"/>
    <Card className="hero stack"><span className="eyebrow">{user?.verification_status==='verified'?'Centre opérationnel':'Compte en attente de vérification'}</span>
      <h1>{user?.operator_type==='independent'?'Votre activité indépendante':`Votre compagnie${user?.display_name?` — ${user.display_name}`:''}`}</h1>
      <p>{configured?'Supervision en temps réel : services, équipage, colis, paiements et incidents.':'Votre compte doit être vérifié par LeRoutier avant de créer des services ou de retirer des fonds. Préparez votre réseau en attendant.'}</p></Card>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {/* A verified company with nothing running gets a guided setup, not an
        empty dashboard. Each step opens the form that completes it. */}
    {configured && !hasOperations && catalog.data && <Card className="stack">
      <div className="between wrap"><h3>Mettons votre compagnie en route</h3>
        <Badge tone={remaining?'warning':'success'}>{remaining?`${remaining} étape${remaining>1?'s':''} restante${remaining>1?'s':''}`:'Terminé'}</Badge></div>
      <div className="checklist">
        {checklist.map((step,i)=><button key={step.label} className={step.done?'done':''} onClick={()=>go(step.path)}>
          <span className="idx">{step.done?<Check size={13}/>:i+1}</span>
          <span className="grow">{step.label}</span>
          <span className="small">{step.done?'Fait':'Ouvrir'}</span>
        </button>)}
      </div>
    </Card>}
    {diagnostics.data && <>
      {/* The strip scrolls sideways on a phone, so it has to be reachable by
          keyboard — otherwise the indicators past the fold are unreachable
          without a touchscreen. */}
      <div className="kpi-scroll" tabIndex={0} role="group" aria-label="Indicateurs du jour">
        <StatCard label="Services aujourd’hui" value={todayServices.length} icon={Radio}/>
        <StatCard label="Paiements échoués" value={diagnostics.data.payments.failed} icon={WalletCards} tone={diagnostics.data.payments.failed?'danger':'default'}/>
        <StatCard label="Incidents ouverts" value={diagnostics.data.incidents.open} icon={ShieldAlert}/>
        <StatCard label="Véhicules sans signal" value={diagnostics.data.services.staleTracking} icon={BusFront} tone={diagnostics.data.services.staleTracking?'warning':'default'}/>
        <StatCard label="Traitements à relancer" value={diagnostics.data.workflows.failed} icon={ShieldCheck} tone={diagnostics.data.workflows.failed?'danger':'default'}/>
        <StatCard label="Colis non retirés (24h+)" value={diagnostics.data.parcels.uncollected} icon={Package} tone={diagnostics.data.parcels.uncollected?'warning':'default'}/>
      </div>
      {diagnostics.data.workflows.failedRuns.length>0 && <Card className="stack">
        <h3>Traitements automatiques à relancer</h3>
        <p className="small muted">Ces opérations n’ont pas abouti. Relancez-les, ou contactez LeRoutier si l’échec persiste.</p>
        {diagnostics.data.workflows.failedRuns.map(run=><div className="between wrap" key={run.id}>
          <span className="small">{WORKFLOW_LABELS[run.workflow]||'Traitement'} · tentative {run.attempts}/3</span>
          <button className="btn btn-soft" disabled={!online || run.attempts>=3} onClick={async()=>{const result=await act(`/workflows/${run.id}/retry`);result.ok?setNotice('Relance enregistrée.'):setError(result.error);diagnostics.reload();}}>Relancer</button></div>)}
      </Card>}
      <p className="small muted">FedaPay : collections {diagnostics.data.fedapay.collections?'actives':'indisponibles'} · versements {diagnostics.data.fedapay.payouts?'configurés':'non configurés'}{diagnostics.data.fedapay.environment?` · ${diagnostics.data.fedapay.environment}`:''}</p>
    </>}
    {user && !user.operator_id && operatorsList.data && <>
      <SectionTitle icon={ShieldCheck} title="Vérification des opérateurs"/>
      {operatorsList.data.map(o=><Card key={o.id} className="between wrap"><div className="stack"><h3>{o.name}</h3><span className="small muted">{o.type==='independent'?'Indépendant':'Compagnie'} · {o.verification_status} · {new Date(o.created_at).toLocaleDateString('fr-FR')}</span></div>
        <div className="controls">{o.verification_status!=='verified' && <button className="btn btn-primary" disabled={!online} onClick={async()=>{const r=await act(`/operators/${o.id}/verification`,{decision:'verified'});r.ok?setNotice('Opérateur vérifié.'):setError(r.error);operatorsList.reload();}}>Vérifier</button>}
        {['pending_verification','verified'].includes(o.verification_status) && <button className="btn btn-soft" disabled={!online} onClick={async()=>{const r=await act(`/operators/${o.id}/verification`,{decision:'suspended'});r.ok?setNotice('Opérateur suspendu.'):setError(r.error);operatorsList.reload();}}>Suspendre</button>}
        {o.verification_status==='pending_verification' && <button className="btn btn-soft" disabled={!online} onClick={async()=>{const r=await act(`/operators/${o.id}/verification`,{decision:'rejected'});r.ok?setNotice('Opérateur refusé.'):setError(r.error);operatorsList.reload();}}>Refuser</button>}</div></Card>)}
    </>}
    <SectionTitle icon={ShieldCheck} title="Approbations en attente"/>
    {approvals.loading || approvals.error || !approvals.data?.length ? <ApiState resource={approvals} empty="Aucune approbation en attente."/> : approvals.data.map(a=><Card key={a.id} className="stack"><div className="between"><h3>{a.workflow} · {a.action}</h3><Badge tone="warning">approbation requise</Badge></div><p className="small muted">{a.rationale}</p><div className="controls"><button className="btn btn-primary" disabled={!online} onClick={()=>approve(a.id,'approved')}>Approuver</button><button className="btn btn-soft" disabled={!online} onClick={()=>approve(a.id,'rejected')}>Refuser</button></div></Card>)}
  </>;
}

// Live fleet: the active services of this operator only. Position, freshness,
// progress, next stop and a confirmed deviation — the operational picture.
// A company never sees another operator's vehicles: the API scopes the query.
function FleetTracking(){
  const {user}=useSession();
  const fleet=useApi(user?.role==='ops'?'/ops/fleet-tracking':null);
  const [selected,setSelected]=useState(null);
  if(fleet.loading) return <SkeletonCards count={1} lines={3}/>;
  if(fleet.error) return <ErrorState text="Impossible de charger le suivi de la flotte." onRetry={fleet.reload}/>;
  const active=fleet.data||[];
  if(!active.length) return <Card className="stack"><strong>Aucun service en circulation</strong>
    <p className="small muted">Le suivi apparaît dès qu’un service est en cours.</p></Card>;
  const current=active.find(s=>s.serviceId===selected)??active[0];
  const SIGNAL={live:['Suivi en direct','success'],delayed:['Signal retardé','warning'],
    stale:['Dernière position connue','warning'],unavailable:['Pas de signal','neutral']};
  return <div className="stack">
    {active.map(service=>{
      const [label,tone]=SIGNAL[service.signal]??SIGNAL.unavailable;
      return <Card key={service.serviceId} className="stack">
        <div className="between wrap">
          <div>
            <strong>{service.stops?.[0]?.city} → {service.stops?.at(-1)?.city}</strong>
            {service.nextStop && <span className="small muted"> · prochain arrêt {service.nextStop.city}</span>}
          </div>
          <div className="end">
            <Badge tone={tone}>{label}</Badge>
            {/* Only a sustained, accuracy-checked deviation is surfaced. */}
            {service.offRoute && <Badge tone="danger">Hors itinéraire</Badge>}
          </div>
        </div>
        <div className="summary">
          {service.progress && <div className="row"><span>Progression</span>
            <span>{Math.round(service.progress.fraction*100)} % · {Math.round(service.progress.remainingM/1000)} km restants</span></div>}
          {service.signalAgeSeconds!==null && <div className="row"><span>Dernière position</span>
            <span>il y a {service.signalAgeSeconds<60?`${service.signalAgeSeconds} s`:`${Math.round(service.signalAgeSeconds/60)} min`}</span></div>}
          {!service.route?.available && <div className="row"><span>Itinéraire routier</span><span>non généré</span></div>}
        </div>
        {service.position && service.route?.available &&
          <button className="btn btn-soft" onClick={()=>setSelected(service.serviceId)}>Voir sur la carte</button>}
      </Card>;
    })}
    {current?.position && current?.route?.available && <Suspense fallback={<SkeletonCards count={1} lines={4}/>}>
      <TransportMap route={current.route.coordinates} progressFraction={current.progress?.fraction??null}
        vehicle={current.position} stops={current.stops??[]} ariaLabel="Carte de la flotte en circulation"/>
    </Suspense>}
  </div>;
}

export function Services(){
  const {user,request,online}=useSession();
  const fleet=useApi(user?'/ops/fleet':null);
  const incidents=useApi(user?'/incidents':null);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  async function act(path,body){setError('');setNotice('');try{await request(path,{method:'POST',body});fleet.reload();setNotice('Action enregistrée.');}catch(e){setError(e.message);}}
  const services=fleet.data?.services||[];
  return <>
    <SectionTitle icon={Radio} title="Flotte en circulation"/>
    <FleetTracking/>
    <SectionTitle icon={Radio} title="Services & lignes"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {fleet.loading || fleet.error || !services.length ? <ApiState resource={fleet} empty="Aucun service publié. Créez une ligne et un service dans Paramètres → Administration, ou ajoutez ici votre premier service."/> : services.map(s=><Card key={s.id} className="stack"><div className="between"><div><h3>{s.registration || 'Sans affectation'}</h3><span className="small muted">{s.driver_name || 'Sans conducteur'} · {s.route_name} · {new Date(s.departure_at).toLocaleString('fr-FR')}</span></div><Badge tone={status('service',s.status).tone}>{status('service',s.status).label}</Badge></div>
      {s.availability && <div className="notice"><div className="between"><strong>Capacité restante</strong><Armchair size={18}/></div>{s.availability.segments.map(segment=><div className="between small" key={segment.sequence}><span>{s.availability.stops[segment.sequence].city} → {s.availability.stops[segment.sequence+1].city}</span><strong>{segment.available} / {s.capacity}</strong></div>)}</div>}
      <div className="controls">{(s.status==='scheduled'?['active','cancelled']:s.status==='active'?['disrupted','completed']:s.status==='disrupted'?['active','cancelled']:[]).map(status=><button className="btn btn-soft" key={status} disabled={!online} onClick={()=>act(`/services/${s.id}/status`,{status})}>Passer à {status}</button>)}</div></Card>)}
    <SectionTitle icon={ShieldAlert} title="Incidents & reprise"/>
    {incidents.loading || incidents.error || !incidents.data?.length ? <ApiState resource={incidents} empty="Aucun incident signalé."/> : incidents.data.map(i=><Card key={i.id} className="stack"><div className="between"><h3>{i.kind}</h3><Badge tone={i.status==='resolved'?'success':'danger'}>{i.status}</Badge></div><p>{i.description}</p><div className="controls">{i.status!=='resolved' && <button className="btn btn-soft" disabled={!online} onClick={()=>act(`/incidents/${i.id}`,{status:'resolved'})}>Résoudre</button>}</div><p className="small muted">Le remplacement de véhicule est proposé par le workflow de reprise — approuvez-le dans « Alertes ».</p></Card>)}
  </>;
}

export function Fleet(){
  const {user,request,online}=useSession();
  const fleet=useApi(user?'/ops/fleet':null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[registration,setRegistration]=useState(''),[capacity,setCapacity]=useState('');
  const vehicles=fleet.data?.vehicles||[];
  async function addVehicle(e){
    e.preventDefault();setError('');setNotice('');
    try{await request('/ops/vehicles',{method:'POST',key:'vehicle-'+crypto.randomUUID(),body:{operatorId:user.operator_id,registration:registration.trim(),capacity:Number(capacity)}});fleet.reload();setNotice('Véhicule ajouté.');setRegistration('');setCapacity('');}
    catch(e){setError(e.message);}
  }
  return <>
    <SectionTitle icon={BusFront} title="Flotte & véhicules"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!vehicles.length && !fleet.loading && <Card><p role="status">Aucun véhicule enregistré. Ajoutez le premier véhicule de la compagnie ci-dessous.</p></Card>}
    {vehicles.map(v=><Card key={v.id} className="between"><div><h3>{v.registration}</h3><span className="small muted">{v.capacity} places</span></div><Badge tone={v.status==='active'?'success':'neutral'}>{v.status}</Badge></Card>)}
    <Card className="stack"><SectionTitle title="Ajouter un véhicule"/>
      <form className="between wrap" onSubmit={addVehicle}>
        <label className="grow">Immatriculation<input className="control" required maxLength={40} value={registration} onChange={e=>setRegistration(e.target.value)}/></label>
        <label className="grow">Nombre de places<input className="control" type="number" min={1} max={100} required value={capacity} onChange={e=>setCapacity(e.target.value)}/></label>
        <button className="btn btn-primary" disabled={!online || !registration.trim() || !capacity}>Ajouter</button>
      </form></Card>
  </>;
}

export function Crew(){
  const {user,request,online}=useSession();
  const catalog=useApi(user?'/ops/provisioning':null);
  const members=useApi(user?.operator_id?`/operators/${user.operator_id}/members`:null);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  const [subject,setSubject]=useState(''),[name,setName]=useState(''),[role,setRole]=useState('driver'),[license,setLicense]=useState('');
  async function provision(e){
    e.preventDefault();setError('');setNotice('');
    const body={operatorId:user.operator_id,subject:subject.trim(),displayName:name.trim(),...(role==='driver'?{licenseReference:license.trim()}:{})};
    const path=role==='driver'?'/ops/drivers':role==='convoyeur'?'/ops/convoyeurs':'/ops/ops-users';
    try{await request(path,{method:'POST',key:'crew-'+crypto.randomUUID(),body});members.reload();catalog.reload();setNotice('Membre provisionné — il peut se connecter avec sa propre identité.');setSubject('');setName('');setLicense('');}
    catch(e){setError(e.message);}
  }
  return <>
    <SectionTitle icon={Users} title="Équipage & personnel"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {members.loading || members.error || !members.data?.length ? <ApiState resource={members} empty="Aucun membre provisionné. Chaque employé se connecte avec son identité personnelle — jamais de compte partagé."/> : members.data.map(m=><Card key={m.id} className="between wrap"><div><h3>{m.display_name}</h3><span className="small muted">{m.role==='driver'?'Conducteur':m.role==='convoyeur'?'Convoyeur':'Agent Ops'}{m.license_reference?` · permis ${m.license_reference}`:''}</span></div><Badge tone={m.active?'success':'danger'}>{m.active?'Actif':'Inactif'}</Badge></Card>)}
    <Card className="stack"><SectionTitle title="Provisionner un membre"/>
      <p className="small muted">Utilisez l’identifiant vérifié du fournisseur d’identité de la personne, jamais un mot de passe. Chaque membre garde son propre compte.</p>
      <form className="stack" onSubmit={provision}>
        <div className="between wrap">
          <label className="grow">Rôle<select className="control" value={role} onChange={e=>setRole(e.target.value)}><option value="driver">Conducteur</option><option value="convoyeur">Convoyeur</option><option value="ops">Agent Ops</option></select></label>
          <label className="grow">Identifiant d’identité<input className="control" required maxLength={255} value={subject} onChange={e=>setSubject(e.target.value)}/></label>
          <label className="grow">Nom complet<input className="control" required minLength={2} maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
          {role==='driver' && <label className="grow">Référence du permis<input className="control" required minLength={2} maxLength={100} value={license} onChange={e=>setLicense(e.target.value)}/></label>}
        </div>
        <button className="btn btn-primary" disabled={!online || !subject.trim() || !name.trim() || (role==='driver' && !license.trim())}>Provisionner</button>
      </form></Card>
  </>;
}

export function Stations(){
  const {user,request,online}=useSession();
  const points=useApi('/boarding-points');
  const proposals=useApi(user && !user.operator_id?'/boarding-points?includeProposed=true':null);
  const stations=useApi(user?.operator_id?`/operators/${user.operator_id}/stations`:null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[stationName,setStationName]=useState(''),[stationPoint,setStationPoint]=useState('');
  async function createStation(){
    setError('');setNotice('');
    try{await request(`/operators/${user.operator_id}/stations`,{method:'POST',body:{name:stationName.trim(),boardingPointId:stationPoint,purposes:['passenger_boarding','passenger_alighting']}});stations.reload();setNotice('Station créée.');setStationName('');setStationPoint('');}
    catch(e){setError(e.message);}
  }
  async function moderate(pointId,decision){
    setError('');setNotice('');
    try{await request(`/boarding-points/${pointId}/moderate`,{method:'POST',body:{decision}});proposals.reload();points.reload();setNotice(decision==='verified'?'Point approuvé.':'Point refusé.');}
    catch(e){setError(e.message);}
  }
  return <>
    <SectionTitle icon={MapPin} title="Stations & points d’embarquement"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {user?.operator_id && <Card className="stack"><SectionTitle title="Station de la compagnie"/>
      {(!stations.data || !stations.data.length) && <p role="status">Aucune station enregistrée. Associez votre compagnie à un lieu vérifié pour préciser vos points d’embarquement.</p>}
      {(stations.data||[]).map(st=><div className="between" key={st.id}><div><h3>{st.name}</h3><span className="small muted">{st.point_name} · {st.city}</span></div><Badge tone="success">active</Badge></div>)}
      <div className="between wrap">
        <label className="grow">Nom de la station<input className="control" value={stationName} onChange={e=>setStationName(e.target.value)} placeholder="Ex. Baobab Express – Gare Bohicon"/></label>
        <label className="grow">Lieu vérifié<select className="control" value={stationPoint} onChange={e=>setStationPoint(e.target.value)}><option value="">Choisir…</option>{(points.data||[]).filter(p=>p.status==='verified').map(p=><option key={p.id} value={p.id}>{p.name} · {p.city}</option>)}</select></label>
        <button className="btn btn-primary" disabled={!online || !stationName.trim() || !stationPoint} onClick={createStation}>Créer la station</button>
      </div></Card>}
    {user && !user.operator_id && <Card className="stack"><SectionTitle title="Points proposés (modération)"/>
      {!proposals?.data?.some(p=>p.status==='proposed') && <p role="status">Aucune proposition en attente de vérification.</p>}
      {(proposals?.data||[]).filter(p=>p.status==='proposed').map(p=><div className="between wrap" key={p.id}><div className="stack"><h3>{p.name}</h3><span className="small muted">{p.city} · {p.type} · {p.description||''}</span></div>
        <div className="controls"><button className="btn btn-primary" disabled={!online} onClick={()=>moderate(p.id,'verified')}>Approuver</button><button className="btn btn-soft" disabled={!online} onClick={()=>moderate(p.id,'rejected')}>Refuser</button></div></div>)}
    </Card>}
    <SectionTitle title="Registre des points vérifiés"/>
    {points.loading || points.error || !(points.data||[]).some(p=>p.status==='verified') ? <ApiState resource={points} empty="Aucun point vérifié dans le registre pour le moment."/>  : (points.data||[]).filter(p=>p.status==='verified').map(p=><Card key={p.id} className="between"><div><h3>{p.name}</h3><span className="small muted">{p.city} · {p.type} · {(p.purposes||[]).join(', ')}</span></div></Card>)}
  </>;
}

export function Parcels(){
  const {user,request,online}=useSession();
  const fleet=useApi(user?'/ops/fleet':null);
  const rateRules=useApi(user?'/ops/parcel-rate-rules':null);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  const [parcelQ,setParcelQ]=useState(''),[parcelsList,setParcelsList]=useState(null),[assignments,setAssignments]=useState({});
  const [ruleBase,setRuleBase]=useState(''),[rulePerKg,setRulePerKg]=useState(''),[ruleBp,setRuleBp]=useState('');
  async function act(path,body,onDone){setError('');setNotice('');try{await request(path,{method:'POST',body});onDone?.();setNotice('Action enregistrée.');}catch(e){setError(e.message);}}
  async function searchParcels(e){e.preventDefault();setError('');try{setParcelsList(await request('/ops/parcels?q='+encodeURIComponent(parcelQ)));}catch(e){setError(e.message);}}
  return <>
    <SectionTitle icon={Package} title="Colis & fret"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <Card className="stack"><form className="between wrap" onSubmit={searchParcels}>
      <label className="grow">Numéro de suivi<input className="control" placeholder="LRP-XXXXXXXX" value={parcelQ} onChange={e=>setParcelQ(e.target.value)}/></label>
      <button className="btn btn-soft" disabled={!online || !parcelQ.trim()}>Rechercher</button></form>
      {parcelsList===null && <p className="small muted">Recherchez une expédition pour l’accepter, l’affecter à un service, la rendre prête au retrait ou enregistrer sa remise.</p>}
      {parcelsList!==null && parcelsList.length===0 && <p role="status">Aucun colis trouvé.</p>}
      {(parcelsList||[]).map(p=><div className="between wrap" key={p.id}><div className="stack"><div className="between"><h3>{p.trackingNumber}</h3><Badge tone={status('parcel',p.status).tone}>{status('parcel',p.status).label}</Badge></div>
        <span className="small muted">{p.category} · {fcfa(p.priceMinor)} · {new Date(p.createdAt).toLocaleDateString('fr-FR')}</span></div>
        <div className="controls">
          {p.status==='created' && <button className="btn btn-primary" disabled={!online} onClick={()=>act(`/parcels/${p.id}/accept`,undefined,async()=>setParcelsList(await request('/ops/parcels?q='+encodeURIComponent(parcelQ))))}>Accepter</button>}
          {p.status==='accepted' && <select className="control" value={assignments[p.id]||''} onChange={e=>setAssignments(a=>({...a,[p.id]:e.target.value}))}><option value="">Affecter au service…</option>{(fleet.data?.services||[]).filter(s=>['scheduled','active'].includes(s.status)).map(s=><option key={s.id} value={s.id}>{s.route_name} · {s.registration}</option>)}</select>}
          {p.status==='accepted' && <button className="btn btn-primary" disabled={!online || !assignments[p.id]} onClick={()=>act(`/parcels/${p.id}/assign`,{serviceId:assignments[p.id]},async()=>setParcelsList(await request('/ops/parcels?q='+encodeURIComponent(parcelQ))))}>Affecter</button>}
          {p.status==='arrived' && <button className="btn btn-primary" disabled={!online} onClick={()=>act(`/parcels/${p.id}/ready`,undefined,async()=>setParcelsList(await request('/ops/parcels?q='+encodeURIComponent(parcelQ))))}>Prêt au retrait</button>}
          {p.status==='ready_for_pickup' && <button className="btn btn-soft" disabled={!online} onClick={async()=>{try{const r=await request(`/parcels/${p.id}/pickup-code`,{method:'POST'});setNotice(`Code de retrait (15 min) : ${r.code}`);}catch(e){setError(e.message);}}}>Code de retrait</button>}
          {p.status==='ready_for_pickup' && <button className="btn btn-primary" disabled={!online} onClick={async()=>{const code=window.prompt('Code de retrait à 6 chiffres :');if(!code)return;try{await request(`/parcels/${p.id}/pickup`,{method:'POST',body:{code}});setParcelsList(await request('/ops/parcels?q='+encodeURIComponent(parcelQ)));setNotice('Colis remis au destinataire.');}catch(e){setError(e.message);}}}>Retirer (code)</button>}
          {['created','accepted','manifested'].includes(p.status) && <button className="btn btn-soft" disabled={!online} onClick={()=>act(`/parcels/${p.id}/cancel`,undefined,async()=>setParcelsList(await request('/ops/parcels?q='+encodeURIComponent(parcelQ))))}>Annuler</button>}
        </div></div>)}
    </Card>
    <SectionTitle icon={Package} title="Grille tarifaire colis"/>
    {rateRules.loading || rateRules.error || !rateRules.data?.length ? <ApiState resource={rateRules} empty="Aucune règle tarifaire configurée — la création de colis échoue sans grille explicite."/> : rateRules.data.map(r=><Card key={r.id} className="between"><div><h3>{fcfa(r.base_minor)}</h3><span className="small muted">+ {r.per_kg_minor} FCFA/kg{r.declared_value_bp?` · +${r.declared_value_bp/100}% valeur déclarée`:''}{r.category?` · catégorie ${r.category}`:''}{r.origin_stop_id?' · trajet spécifique':' · tous trajets'}</span></div></Card>)}
    <Card className="stack"><div className="between wrap">
      <label>Base (FCFA)<input className="control" type="number" min={0} value={ruleBase} onChange={e=>setRuleBase(e.target.value)}/></label>
      <label>Par kg (FCFA)<input className="control" type="number" min={0} value={rulePerKg} onChange={e=>setRulePerKg(e.target.value)}/></label>
      <label>Valeur déclarée (‱)<input className="control" type="number" min={0} value={ruleBp} onChange={e=>setRuleBp(e.target.value)}/></label>
      <button className="btn btn-soft" disabled={!online || ruleBase===''} onClick={()=>act('/ops/parcel-rate-rules',{baseMinor:Number(ruleBase),perKgMinor:Number(rulePerKg||0),declaredValueBp:Number(ruleBp||0)},()=>rateRules.reload())}>Ajouter la règle</button>
    </div></Card>
  </>;
}

export function Payments(){
  const {user,request,online}=useSession();
  const [paymentStatus,setPaymentStatus]=useState('failed');
  const payments=useApi(user?`/ops/payments?status=${paymentStatus}`:null);
  const payouts=useApi(user?'/ops/payouts':null);
  const bookings=useApi(user?'/ops/bookings':null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[reference,setReference]=useState('');
  async function act(path,body,method='POST',key=undefined,onDone=undefined){setError('');setNotice('');try{await request(path,{method,body,key});onDone?.();setNotice('Action enregistrée.');}catch(e){setError(e.message);}}
  return <>
    <SectionTitle icon={WalletCards} title="Paiements"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <Card className="stack"><SectionTitle title="Paiements au guichet (espèces)"/>
      {(!bookings.data || !bookings.data.length) && <p role="status">Aucune option de réservation en attente.</p>}
      {bookings.loading || bookings.error ? <ApiState resource={bookings}/> : <>
        <label>Référence du reçu<input className="control" value={reference} onChange={e=>setReference(e.target.value)} maxLength={100}/></label>
        <p className="small muted">Enregistrer uniquement un paiement réellement reçu. Le passager ne paie jamais en espèces dans l’application — ce guichet est le canal espèces de la compagnie.</p>
        {(bookings.data||[]).filter(b=>b.status==='held').map(b=><div className="between wrap" key={b.id}><span className="small">{b.passenger_name} · {b.amount_minor} FCFA</span><button className="btn btn-primary" disabled={!online || !reference.trim()} onClick={()=>act(`/bookings/${b.id}/payments`,{provider:'cash',reference:reference.trim(),amountMinor:b.amount_minor,currency:'XOF'},'POST','cash-'+b.id,()=>bookings.reload())}>Enregistrer le paiement</button></div>)}
      </>}
    </Card>
    <SectionTitle title="Paiements en ligne (FedaPay)" trailing={<select className="control" value={paymentStatus} onChange={e=>setPaymentStatus(e.target.value)}>{['pending','failed','refunded'].map(s=><option key={s} value={s}>{status('payment',s).label}</option>)}</select>}/>
    {payments.loading || payments.error || !payments.data?.length ? <ApiState resource={payments} empty={`Aucun paiement ${status('payment',paymentStatus).label.toLowerCase()}.`}/> : payments.data.map(p=><Card key={p.id} className="between wrap"><div className="stack"><div className="between"><h3>{p.passengerName} · {p.amountMinor.toLocaleString('fr-FR')} {p.currency}</h3><Badge tone={p.status==='succeeded'?'success':p.status==='failed'?'danger':'neutral'}>{status('payment',p.status).label}</Badge></div><span className="small muted">{p.reconciliation==='review'?<Badge tone="danger">à examiner</Badge>:p.reconciliation}</span></div>
      <button className="btn btn-soft" disabled={!online} onClick={()=>act(`/ops/payments/${p.id}/reconcile`,undefined,'POST',undefined,()=>payments.reload())}>Réconcilier</button></Card>)}
    <SectionTitle title="Versements conducteurs"/>
    {payouts.loading || payouts.error || !payouts.data?.length ? <ApiState resource={payouts} empty="Aucun versement demandé."/> : payouts.data.map(p=><Card key={p.id} className="between wrap"><div className="stack"><div className="between"><h3>{p.driverName} · {p.amountMinor.toLocaleString('fr-FR')} {p.currency}</h3><Badge tone={status('payout',p.status).tone}>{status('payout',p.status).label}</Badge></div><span className="small muted">{new Date(p.createdAt).toLocaleString('fr-FR')} · destination {p.destinationPhone} · réf. prestataire {p.provider_reference ?? '—'}</span></div>
      <div className="controls">{(p.status==='requested'||p.status==='failed') && <button className="btn btn-primary" disabled={!online} onClick={()=>act(`/ops/payouts/${p.id}/approve`,undefined,'POST',undefined,()=>payouts.reload())}>{p.status==='failed'?'Relancer le versement':'Valider et envoyer'}</button>}
      {p.status==='processing' && <button className="btn btn-soft" disabled={!online} onClick={()=>act(`/ops/payouts/${p.id}/reconcile`,undefined,'POST',undefined,()=>payouts.reload())}>Vérifier auprès du prestataire</button>}</div></Card>)}
  </>;
}

export function Settlements(){
  const {user,request,online}=useSession();
  const operatorPayouts=useApi(user?'/ops/operator-payouts':null);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  async function act(path,onDone){setError('');setNotice('');try{await request(path,{method:'POST'});onDone?.();setNotice('Action enregistrée.');}catch(e){setError(e.message);}}
  return <>
    <SectionTitle icon={WalletCards} title="Règlements & retraits opérateurs"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <p className="small muted">La recette appartient à l’opérateur. Les retraits des chauffeurs indépendants sont validés ici — les compagnies gèrent leurs versements selon leur propre politique.</p>
    {operatorPayouts.loading || operatorPayouts.error || !operatorPayouts.data?.length ? <ApiState resource={operatorPayouts} empty="Aucun retrait opérateur."/> : operatorPayouts.data.map(p=><Card key={p.id} className="between wrap"><div className="stack"><div className="between"><h3>{p.operatorName} · {fcfa(p.amountMinor)}</h3><Badge tone={status('payout',p.status).tone}>{status('payout',p.status).label}</Badge></div><span className="small muted">{new Date(p.createdAt).toLocaleString('fr-FR')} · {p.phoneNumber} · {p.operatorType}</span></div>
      <div className="controls">{(p.status==='requested'||p.status==='failed') && <button className="btn btn-primary" disabled={!online} onClick={()=>act(`/ops/operator-payouts/${p.id}/approve`,()=>operatorPayouts.reload())}>{p.status==='failed'?'Relancer':'Valider et envoyer'}</button>}
      {p.status==='processing' && <button className="btn btn-soft" disabled={!online} onClick={()=>act(`/ops/operator-payouts/${p.id}/reconcile`,()=>operatorPayouts.reload())}>Vérifier auprès du prestataire</button>}</div></Card>)}
  </>;
}

export function Incidents(){
  const {user,request,online}=useSession();
  const incidents=useApi(user?'/incidents':null);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  async function resolve(id){
    setError('');setNotice('');
    try{await request(`/incidents/${id}`,{method:'PATCH',body:{status:'resolved'}});incidents.reload();setNotice('Incident résolu.');}
    catch(e){setError(e.message);}
  }
  return <>
    <SectionTitle icon={ShieldAlert} title="Incidents"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {incidents.loading || incidents.error || !incidents.data?.length ? <ApiState resource={incidents} empty="Aucun incident signalé sur le réseau."/> : incidents.data.map(i=><Card key={i.id} className="stack"><div className="between"><h3>{i.kind}</h3><Badge tone={i.status==='resolved'?'success':'danger'}>{i.status}</Badge></div><p>{i.description}</p>{i.status!=='resolved' && <div className="controls"><button className="btn btn-soft" disabled={!online} onClick={()=>resolve(i.id)}>Résoudre</button></div>}</Card>)}
  </>;
}

export function Alerts(){
  const {user,request,online}=useSession();
  const approvals=useApi(user?'/agent/approvals':null);
  const diagnostics=useApi(user?'/ops/diagnostics':null);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  async function decide(approvalId,decision){
    setError('');setNotice('');
    try{await request(`/agent/approvals/${approvalId}`,{method:'POST',body:{decision}});approvals.reload();diagnostics.reload();setNotice(decision==='approved'?'Approbation exécutée.':'Demande refusée.');}
    catch(e){setError(e.message);}
  }
  return <>
    <SectionTitle icon={ShieldCheck} title="Alertes & approbations agentiques"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {approvals.loading || approvals.error || !approvals.data?.length ? <ApiState resource={approvals} empty="Aucune approbation en attente."/> : approvals.data.map(a=><Card key={a.id} className="stack"><div className="between"><h3>{a.workflow} · {a.action}</h3><Badge tone="warning">approbation requise</Badge></div><p className="small muted">{a.rationale}</p><div className="controls"><button className="btn btn-primary" disabled={!online} onClick={()=>decide(a.id,'approved')}>Approuver</button><button className="btn btn-soft" disabled={!online} onClick={()=>decide(a.id,'rejected')}>Refuser</button></div></Card>)}
    {diagnostics.data?.workflows?.failedRuns?.length>0 && <SectionTitle title="Workflows en échec"/>}
    {(diagnostics.data?.workflows?.failedRuns||[]).map(run=><Card key={run.id} className="between wrap"><span className="small">{run.workflow} · {run.step}{run.failure_code?` · ${run.failure_code}`:''} · tentative {run.attempts}/3</span>
      <button className="btn btn-soft" disabled={!online || run.attempts>=3} onClick={async()=>{try{await request(`/workflows/${run.id}/retry`,{method:'POST'});diagnostics.reload();setNotice('Relance enregistrée.');}catch(e){setError(e.message);}}}>Relancer</button></Card>)}
  </>;
}

export function Settings(){
  return <Provisioning/>;
}
