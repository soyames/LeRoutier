import { useState } from 'react';
import { useApi,useSession } from '@leroutier/config/client';
import { Badge,Card,EmptyState,SectionTitle,SkeletonCards,status } from '@leroutier/ui';
import { Building2,CircleUserRound,Database,ShieldCheck,TriangleAlert,WalletCards,CarFront,ExternalLink } from 'lucide-react';

const fmtBytes=value=>{if(!Number.isFinite(Number(value)))return '—';const n=Number(value);if(n<1024)return `${n} o`;const units=['Ko','Mo','Go','To'];let v=n/1024,i=0;while(v>=1024&&i<units.length-1){v/=1024;i++;}return `${v.toFixed(v>=10?1:2)} ${units[i]}`;};
const fmtDate=value=>value?new Date(value).toLocaleString('fr-FR'):'—';
const authProvider=issuer=>issuer?.includes('securetoken.google.com')?'Firebase / Google':issuer?'Fournisseur externe':'Aucune identité externe';
const EVIDENCE_LABELS={company_registration:'Immatriculation / RCCM',tax_registration:'Fiscalité / IFU',legal_representative_identity:'Identité du représentant légal',transport_authorization:'Autorisation de transport',registered_address:'Adresse officielle',identity:'Pièce d’identité',driving_license:'Permis de conduire',vehicle_registration:'Immatriculation du véhicule',insurance:'Assurance',roadworthiness:'Contrôle technique',driver_photo:'Photo du chauffeur',vehicle_photo:'Photo du véhicule'};

function PlatformOnly({children}){const {user}=useSession();if(!user||user.role!=='ops'||user.operator_id)return <EmptyState icon={ShieldCheck} title="Accès plateforme requis" text="Cette page est réservée à l’exploitation de la plateforme LeRoutier."/>;return children;}
function usePlatformHealth(){return useApi('/ops/health');}

export function PlatformOverview(){const health=usePlatformHealth();return <PlatformOnly><div className="stack"><SectionTitle title="Vue plateforme" icon={ShieldCheck}/>{health.loading?<SkeletonCards count={3}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:<><div className="stats-grid"><Card className="stat-card"><span>Utilisateurs</span><strong>{health.data.counts.users_total}</strong><small>{health.data.counts.users_authenticated} avec identité authentifiée</small></Card><Card className="stat-card"><span>Vérifications en attente</span><strong>{health.data.counts.kyc_pending}</strong><small>opérateurs à examiner</small></Card><Card className="stat-card"><span>Incidents ouverts</span><strong>{health.data.counts.incidents_open}</strong><small>toute la plateforme</small></Card><Card className="stat-card"><span>Anomalies financières</span><strong>{health.data.counts.payments_failed_total+health.data.counts.payouts_failed_total}</strong><small>paiements et versements</small></Card></div><Card className="stack"><div className="between wrap"><div><strong>Capacité système</strong><p className="small muted">La base reste prioritaire pour les opérations existantes.</p></div><Badge tone={health.data.storage.registrationsOpen?'success':'warning'}>{health.data.storage.registrationsOpen?'Inscriptions ouvertes':'Inscriptions suspendues'}</Badge></div><p>{fmtBytes(health.data.storage.usedBytes)} utilisés{health.data.storage.limitBytes?` sur ${fmtBytes(health.data.storage.limitBytes)}`:''}{health.data.storage.usedPercent!==null?` · ${health.data.storage.usedPercent} %`:''}</p><p className="small muted">Seuil d’arrêt des nouvelles inscriptions : {health.data.storage.registrationStopPercent} %.</p></Card></>}</div></PlatformOnly>;}

// Search and paging are the server's. The console asks for a page and shows
// exactly what came back, including how many matched in total — so an empty
// result means "no such account", not "beyond the first 500".
export function PlatformUsers(){
  const [query,setQuery]=useState(''),[term,setTerm]=useState(''),[page,setPage]=useState(0);
  const size=25;
  const params=new URLSearchParams({limit:String(size),offset:String(page*size)});
  if(term)params.set('q',term);
  const result=useApi(`/ops/users?${params}`);
  // Typing narrows a search; it must also return to the first page, or the
  // new query is read from an offset that belongs to the previous one.
  function submit(event){event.preventDefault();setPage(0);setTerm(query.trim());}
  const data=result.data,users=data?.users||[],total=data?.total??0;
  const shown=page*size+users.length,more=shown<total;
  return <PlatformOnly><div className="stack"><SectionTitle title="Utilisateurs & authentifications" icon={CircleUserRound}/>
    <Card className="stack"><p className="small muted">Vue administrative des comptes LeRoutier. Les mots de passe, jetons Firebase et secrets d’authentification ne sont jamais exposés.</p>
      <form className="stack" onSubmit={submit}><label>Rechercher un utilisateur
        <input className="control" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Nom, e-mail, rôle, opérateur ou identifiant"/></label>
        <div className="controls"><button className="btn btn-primary">Rechercher</button>
          {term&&<button type="button" className="btn btn-soft" onClick={()=>{setQuery('');setTerm('');setPage(0);}}>Effacer</button>}</div></form></Card>
    {result.loading?<SkeletonCards count={4}/>:result.error?<Card><p role="alert">{result.error}</p></Card>:users.length?<>
      <p className="small muted" role="status">{total} compte{total>1?'s':''} correspondant{total>1?'s':''} · affichage {page*size+1}–{shown}</p>
      {users.map(u=><Card key={u.id} className="stack">
        <div className="between wrap"><div><strong>{u.display_name||'Profil sans nom'}</strong><p className="small muted">{u.role} · {u.operator_name||'Aucun opérateur'}</p></div>
          <div className="controls"><Badge tone={u.active?'success':'warning'}>{u.active?'Actif':'Inactif'}</Badge>
            <Badge tone={u.authenticated?'success':'neutral'}>{u.authenticated?'Authentifié':'Sans identité externe'}</Badge>{u.is_demo&&<Badge tone="warning">TEST</Badge>}</div></div>
        <div className="summary"><div className="row"><span>E-mail de notification</span><span>{u.notification_email||'—'}</span></div>
          <div className="row"><span>Téléphone</span><span>{u.passenger_phone||'—'}</span></div>
          <div className="row"><span>Fournisseur d’identité</span><span>{authProvider(u.auth_issuer)}</span></div>
          <div className="row"><span>Compte créé</span><span>{fmtDate(u.created_at)}</span></div>
          <div className="row"><span>Profil complété</span><span>{u.profile_completed_at?'Oui':'Non'}</span></div>
          <div className="row"><span>Identifiant interne</span><span className="mono">{u.id}</span></div></div>
      </Card>)}
      {(page>0||more)&&<div className="controls">
        <button className="btn btn-soft" disabled={page===0} onClick={()=>setPage(p=>Math.max(0,p-1))}>Page précédente</button>
        <button className="btn btn-soft" disabled={!more} onClick={()=>setPage(p=>p+1)}>Page suivante</button></div>}
    </>:<EmptyState icon={CircleUserRound} title="Aucun utilisateur trouvé" text={term?`Aucun compte ne correspond à « ${term} ».`:'Aucun compte enregistré.'}/>}
  </div></PlatformOnly>;
}

function EvidenceRow({operator,evidence,onReview,online}){const tone=evidence.status==='verified'?'success':evidence.status==='rejected'?'danger':'warning';return <div className="card stack" style={{padding:12}}><div className="between wrap"><div><strong>{EVIDENCE_LABELS[evidence.kind]||evidence.kind}</strong>{evidence.reference&&<p className="small muted">Référence : {evidence.reference}</p>}</div><Badge tone={tone}>{evidence.status==='verified'?'Validé':evidence.status==='rejected'?'Refusé':'À examiner'}</Badge></div>{evidence.fileUrl&&<a className="btn btn-soft" href={evidence.fileUrl} target="_blank" rel="noreferrer"><ExternalLink size={14}/>Ouvrir le justificatif</a>}<div className="controls"><button className="btn btn-primary" disabled={!online||evidence.status==='verified'} onClick={()=>onReview(operator.id,evidence.id,'verified')}>Valider ce justificatif</button><button className="btn btn-soft" disabled={!online||evidence.status==='rejected'} onClick={()=>onReview(operator.id,evidence.id,'rejected')}>Refuser</button></div></div>;}

export function PlatformVerification(){
  const health=usePlatformHealth(),{request,online}=useSession();const [notice,setNotice]=useState(''),[error,setError]=useState('');
  async function decide(id,decision){setNotice('');setError('');try{await request(`/operators/${id}/verification`,{method:'POST',body:{decision}});setNotice('Décision enregistrée.');health.reload();}catch(e){setError(e.message);}}
  async function review(operatorId,evidenceId,status){await decide(operatorId,{type:'evidence',evidenceId,status});}
  return <PlatformOnly><div className="stack"><SectionTitle title="Vérifications & KYC" icon={ShieldCheck}/>
    <Card className="stack"><p><strong>Deux règles différentes.</strong></p><p className="small muted">Compagnie : LeRoutier vérifie l’entreprise, son représentant légal, son immatriculation, sa situation fiscale, son adresse et son autorisation de transport. Les chauffeurs salariés de cette compagnie ne fournissent pas leur pièce d’identité individuelle à LeRoutier pour cette vérification.</p><p className="small muted">Chauffeur indépendant : LeRoutier vérifie personnellement son identité, son permis, son autorisation, son assurance, son contrôle technique et son véhicule. Aucune biométrie ni validation gouvernementale automatique n’est prétendue : la décision est humaine et auditée.</p></Card>
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
    {health.loading?<SkeletonCards count={3}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:(health.data.kycQueue||[]).length?health.data.kycQueue.map(o=>{const complete=o.evidenceComplete===true,missing=o.evidenceMissing||[];return <Card key={o.id} className="stack">
      <div className="between wrap"><div><strong>{o.name}</strong><p className="small muted">{o.type==='independent'?'KYC chauffeur indépendant':'Vérification entreprise (KYB)'} · {o.country?.toUpperCase()||'—'}</p></div><Badge tone={complete?'success':'warning'}>{complete?'Dossier complet':'Justificatifs à vérifier'}</Badge></div>
      {o.type==='company'?<div className="summary"><div className="row"><span>Raison sociale</span><span>{o.legal_name||'—'}</span></div><div className="row"><span>RCCM / immatriculation</span><span>{o.registration_ref||'—'}</span></div><div className="row"><span>Référence fiscale / IFU</span><span>{o.tax_reference||'—'}</span></div><div className="row"><span>Représentant légal</span><span>{o.representative_name||o.admin_name||'—'}</span></div><div className="row"><span>Pièce du représentant</span><span>{o.representative_id_reference||'—'}</span></div><div className="row"><span>Autorisation transport</span><span>{o.transport_authorization_reference||'—'}</span></div><div className="row"><span>Adresse officielle</span><span>{o.registered_address||'—'}</span></div><div className="row"><span>Téléphone</span><span>{o.contact_phone||'—'}</span></div></div>
        :<><div className="between wrap">{o.driver_photo_url?<img src={o.driver_photo_url} alt={`Photo de ${o.owner_name||o.name}`} referrerPolicy="no-referrer" style={{width:88,height:88,objectFit:'cover',borderRadius:16}}/>:<CarFront size={44}/>}<div className="grow"><strong>{o.owner_name||o.name}</strong><p className="small muted">{[o.vehicle_make,o.vehicle_model,o.vehicle_color,o.vehicle_year].filter(Boolean).join(' · ')}</p><p><strong>{o.vehicle_registration||'Immatriculation non renseignée'}</strong></p></div></div><div className="summary"><div className="row"><span>Type de pièce</span><span>{o.id_document_type||'—'}</span></div><div className="row"><span>Référence identité</span><span>{o.id_document_reference||'—'}</span></div><div className="row"><span>Permis</span><span>{o.license_reference||'—'}</span></div><div className="row"><span>Autorisation transport</span><span>{o.transport_authorization_reference||'—'}</span></div><div className="row"><span>Assurance</span><span>{o.insurance_reference||'—'}</span></div><div className="row"><span>Contrôle technique</span><span>{o.roadworthiness_reference||'—'}</span></div></div></>}
      <h3>Justificatifs</h3>{(o.evidence||[]).map(e=><EvidenceRow key={e.id} operator={o} evidence={e} onReview={review} online={online}/>)}
      {!complete&&missing.length>0&&<p className="small muted">Pièces encore à valider : {missing.map(k=>EVIDENCE_LABELS[k]||k).join(', ')}.</p>}
      <div className="between wrap"><span className="small muted">Demande créée : {fmtDate(o.created_at)}</span><div className="controls"><button className="btn btn-primary" disabled={!online||!complete} onClick={()=>decide(o.id,'verified')}>Valider le dossier</button><button className="btn btn-soft" disabled={!online} onClick={()=>decide(o.id,'suspended')}>Suspendre</button><button className="btn btn-soft" disabled={!online} onClick={()=>decide(o.id,'rejected')}>Refuser l’opérateur</button></div></div>
    </Card>;}):<EmptyState icon={ShieldCheck} title="Aucune vérification en attente" text="Les nouvelles demandes d’opérateurs apparaîtront ici."/>}
  </div></PlatformOnly>;
}

export function PlatformFinance(){const health=usePlatformHealth();return <PlatformOnly><div className="stack"><SectionTitle title="Finances & anomalies" icon={WalletCards}/>{health.loading?<SkeletonCards count={3}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:<><Card className="stack"><h3>Paiements échoués</h3>{(health.data.paymentAnomalies||[]).length?health.data.paymentAnomalies.map(x=><div className="row" key={x.id}><span>{x.operator_name} · {x.amount_minor} {x.currency}</span><span>{fmtDate(x.created_at)}</span></div>):<p className="small muted">Aucun paiement échoué enregistré.</p>}</Card><Card className="stack"><h3>Versements échoués ou renversés</h3>{(health.data.payoutAnomalies||[]).length?health.data.payoutAnomalies.map(x=><div className="row" key={x.id}><span>{x.operator_name||'Opérateur'} · {x.beneficiary||'Bénéficiaire'} · {x.amount_minor} {x.currency}</span><span>{x.status} · {fmtDate(x.created_at)}</span></div>):<p className="small muted">Aucune anomalie de versement enregistrée.</p>}</Card></>}</div></PlatformOnly>;}
export function PlatformIncidents(){const health=usePlatformHealth();return <PlatformOnly><div className="stack"><SectionTitle title="Incidents plateforme" icon={TriangleAlert}/>{health.loading?<SkeletonCards count={3}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:(health.data.incidents||[]).length?health.data.incidents.map(i=><Card key={i.id} className="stack"><div className="between wrap"><strong>{i.operator_name} · {i.kind}</strong><Badge tone={i.severity==='high'?'danger':'warning'}>{i.severity}</Badge></div><p>{i.description||'Aucune description.'}</p><p className="small muted">{i.status} · {fmtDate(i.created_at)} · service {i.service_id}</p></Card>):<EmptyState icon={TriangleAlert} title="Aucun incident ouvert" text="Les incidents actifs de tous les opérateurs apparaîtront ici."/>}</div></PlatformOnly>;}
export function PlatformSystem(){const health=usePlatformHealth();return <PlatformOnly><div className="stack"><SectionTitle title="Système & capacité" icon={Database}/>{health.loading?<SkeletonCards count={2}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:<><Card className="stack"><div className="between wrap"><strong>Base de données</strong><Badge tone={health.data.storage.registrationsOpen?'success':'warning'}>{health.data.storage.registrationsOpen?'Capacité disponible':'Nouvelles inscriptions suspendues'}</Badge></div><div className="summary"><div className="row"><span>Stockage utilisé</span><span>{fmtBytes(health.data.storage.usedBytes)}</span></div><div className="row"><span>Limite configurée</span><span>{health.data.storage.limitBytes?fmtBytes(health.data.storage.limitBytes):'Non configurée'}</span></div><div className="row"><span>Utilisation</span><span>{health.data.storage.usedPercent===null?'—':`${health.data.storage.usedPercent} %`}</span></div><div className="row"><span>Seuil d’arrêt des inscriptions</span><span>{health.data.storage.registrationStopPercent} %</span></div><div className="row"><span>Inscriptions</span><span>{health.data.storage.registrationsOpen?'Ouvertes':'Suspendues'}</span></div></div></Card><Card className="stack"><h3>État technique</h3><div className="summary"><div className="row"><span>Migrations</span><span>{health.data.migrations.matched?'À jour':'À vérifier'}</span></div><div className="row"><span>Notifications en échec</span><span>{health.data.counts.notification_failed}</span></div><div className="row"><span>Canaux indisponibles</span><span>{health.data.counts.notification_unavailable}</span></div><div className="row"><span>Événements à reprendre</span><span>{health.data.counts.dispatch_dead}</span></div><div className="row"><span>Échecs de routage (24h)</span><span>{health.data.counts.routing_failed}</span></div></div></Card></>}</div></PlatformOnly>;}
// Any operator's dossier stays re-readable, not only the ones still queued
// for a first decision: re-opening a verified company's file is exactly what
// oversight means. The evidence is fetched on demand rather than shipped with
// every list, so document references travel only when a reviewer asks.
function OperatorDossier({operatorId}){
  const evidence=useApi(`/ops/operators/${operatorId}/evidence`);
  if(evidence.loading)return <SkeletonCards count={2}/>;
  if(evidence.error)return <p role="alert">{evidence.error}</p>;
  if(!(evidence.data||[]).length)return <p className="small muted">Aucun justificatif enregistré pour cet opérateur.</p>;
  return <div className="stack">{evidence.data.map(e=><div className="row" key={e.id}>
    <span>{EVIDENCE_LABELS[e.kind]||e.kind}{e.reference?` · ${e.reference}`:''}</span>
    <span className="controls"><Badge tone={e.status==='verified'?'success':e.status==='rejected'?'danger':'warning'}>{e.status==='verified'?'Validé':e.status==='rejected'?'Refusé':'À examiner'}</Badge>
      {e.file_url&&<a className="btn btn-soft" href={e.file_url} target="_blank" rel="noreferrer noopener"><ExternalLink size={14}/>Ouvrir</a>}</span>
  </div>)}</div>;
}
export function PlatformOperators(){
  const operators=useApi('/operators');const [open,setOpen]=useState(null);
  return <PlatformOnly><div className="stack"><SectionTitle title="Opérateurs" icon={Building2}/>
    {operators.loading?<SkeletonCards count={4}/>:operators.error?<Card><p role="alert">{operators.error}</p></Card>:(operators.data||[]).length?operators.data.map(o=><Card key={o.id} className="stack">
      <div className="between wrap"><div><strong>{o.name}</strong><p className="small muted">{o.type==='independent'?'Chauffeur indépendant':'Compagnie'} · {o.country?.toUpperCase()||'—'} · créé le {new Date(o.created_at).toLocaleDateString('fr-FR')}</p></div>
        <Badge tone={status('verification',o.verification_status).tone}>{status('verification',o.verification_status).label}</Badge></div>
      <div className="controls"><button className="btn btn-soft" aria-expanded={open===o.id} onClick={()=>setOpen(open===o.id?null:o.id)}>{open===o.id?'Masquer le dossier':'Consulter le dossier'}</button></div>
      {open===o.id&&<OperatorDossier operatorId={o.id}/>}
    </Card>):<EmptyState icon={Building2} title="Aucun opérateur" text="Les compagnies et indépendants enregistrés apparaîtront ici."/>}
  </div></PlatformOnly>;
}
