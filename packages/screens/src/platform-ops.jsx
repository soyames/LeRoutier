import { useMemo, useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Badge, Card, EmptyState, SectionTitle, SkeletonCards } from '@leroutier/ui';
import { Building2, CircleUserRound, Database, ShieldCheck, TriangleAlert, WalletCards } from 'lucide-react';

const fmtBytes=value=>{
  if(!Number.isFinite(Number(value)))return '—';
  const n=Number(value); if(n<1024)return `${n} o`;
  const units=['Ko','Mo','Go','To']; let v=n/1024,i=0;
  while(v>=1024&&i<units.length-1){v/=1024;i++;}
  return `${v.toFixed(v>=10?1:2)} ${units[i]}`;
};
const fmtDate=value=>value?new Date(value).toLocaleString('fr-FR'):'—';
const authProvider=issuer=>issuer?.includes('securetoken.google.com')?'Firebase / Google':issuer?'Fournisseur externe':'Aucune identité externe';

function PlatformOnly({children}){
  const {user}=useSession();
  if(!user || user.role!=='ops' || user.operator_id) return <EmptyState icon={ShieldCheck} title="Accès plateforme requis" text="Cette page est réservée à l’exploitation de la plateforme LeRoutier."/>;
  return children;
}

function usePlatformHealth(){return useApi('/ops/health');}

export function PlatformOverview(){
  const health=usePlatformHealth();
  return <PlatformOnly><div className="stack">
    <SectionTitle title="Vue plateforme" icon={ShieldCheck}/>
    {health.loading?<SkeletonCards count={3}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:<>
      <div className="stats-grid">
        <Card className="stat-card"><span>Utilisateurs</span><strong>{health.data.counts.users_total}</strong><small>{health.data.counts.users_authenticated} avec identité authentifiée</small></Card>
        <Card className="stat-card"><span>Vérifications en attente</span><strong>{health.data.counts.kyc_pending}</strong><small>opérateurs à examiner</small></Card>
        <Card className="stat-card"><span>Incidents ouverts</span><strong>{health.data.counts.incidents_open}</strong><small>toute la plateforme</small></Card>
        <Card className="stat-card"><span>Anomalies financières</span><strong>{health.data.counts.payments_failed_total+health.data.counts.payouts_failed_total}</strong><small>paiements et versements</small></Card>
      </div>
      <Card className="stack"><div className="between wrap"><div><strong>Capacité système</strong><p className="small muted">La base reste prioritaire pour les opérations existantes.</p></div><Badge tone={health.data.storage.registrationsOpen?'success':'warning'}>{health.data.storage.registrationsOpen?'Inscriptions ouvertes':'Inscriptions suspendues'}</Badge></div>
        <p>{fmtBytes(health.data.storage.usedBytes)} utilisés{health.data.storage.limitBytes?` sur ${fmtBytes(health.data.storage.limitBytes)}`:''}{health.data.storage.usedPercent!==null?` · ${health.data.storage.usedPercent} %`:''}</p>
        <p className="small muted">Seuil d’arrêt des nouvelles inscriptions : {health.data.storage.registrationStopPercent} %.</p></Card>
    </>}
  </div></PlatformOnly>;
}

export function PlatformUsers(){
  const health=usePlatformHealth();
  const [query,setQuery]=useState('');
  const users=useMemo(()=>{
    const q=query.trim().toLowerCase();
    return (health.data?.users||[]).filter(u=>!q||[u.display_name,u.notification_email,u.role,u.operator_name,u.id].some(v=>String(v||'').toLowerCase().includes(q)));
  },[health.data,query]);
  return <PlatformOnly><div className="stack">
    <SectionTitle title="Utilisateurs & authentifications" icon={CircleUserRound}/>
    <Card className="stack"><p className="small muted">Vue administrative des comptes LeRoutier. Les mots de passe, jetons Firebase et secrets d’authentification ne sont jamais exposés.</p>
      <label>Rechercher un utilisateur<input className="control" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Nom, e-mail, rôle, opérateur ou identifiant"/></label></Card>
    {health.loading?<SkeletonCards count={4}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:users.length?users.map(u=><Card key={u.id} className="stack">
      <div className="between wrap"><div><strong>{u.display_name||'Profil sans nom'}</strong><p className="small muted">{u.role} · {u.operator_name||'Aucun opérateur'}</p></div><div className="controls"><Badge tone={u.active?'success':'warning'}>{u.active?'Actif':'Inactif'}</Badge><Badge tone={u.authenticated?'success':'neutral'}>{u.authenticated?'Authentifié':'Sans identité externe'}</Badge>{u.is_demo&&<Badge tone="warning">TEST</Badge>}</div></div>
      <div className="summary"><div className="row"><span>E-mail de notification</span><span>{u.notification_email||'—'}</span></div><div className="row"><span>Téléphone</span><span>{u.passenger_phone||'—'}</span></div><div className="row"><span>Fournisseur d’identité</span><span>{authProvider(u.auth_issuer)}</span></div><div className="row"><span>Compte créé</span><span>{fmtDate(u.created_at)}</span></div><div className="row"><span>Profil complété</span><span>{u.profile_completed_at?'Oui':'Non'}</span></div>{u.license_reference&&<div className="row"><span>Permis</span><span>{u.license_reference}</span></div>}<div className="row"><span>Identifiant interne</span><span className="mono">{u.id}</span></div></div>
    </Card>):<EmptyState icon={CircleUserRound} title="Aucun utilisateur trouvé" text="Modifiez la recherche pour afficher d’autres comptes."/>}
  </div></PlatformOnly>;
}

export function PlatformVerification(){
  const health=usePlatformHealth();
  const {request,online}=useSession();
  const [notice,setNotice]=useState(''),[error,setError]=useState('');
  async function decide(id,decision){setNotice('');setError('');try{await request(`/operators/${id}/verification`,{method:'POST',body:{decision}});setNotice('Décision enregistrée.');health.reload();}catch(e){setError(e.message);}}
  return <PlatformOnly><div className="stack">
    <SectionTitle title="Vérifications & KYC" icon={ShieldCheck}/>
    <Card><p className="small muted">LeRoutier utilise une vérification humaine et fondée sur les documents/références disponibles. Cette page ne prétend pas effectuer de biométrie ou de validation gouvernementale automatique.</p></Card>
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
    {health.loading?<SkeletonCards count={3}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:(health.data.kycQueue||[]).length?health.data.kycQueue.map(o=><Card key={o.id} className="stack">
      <div className="between wrap"><div><strong>{o.name}</strong><p className="small muted">{o.type==='independent'?'Chauffeur indépendant':'Compagnie'} · {o.country?.toUpperCase()||'—'}</p></div><Badge tone={o.verification_status==='pending_verification'?'warning':'neutral'}>{o.verification_status}</Badge></div>
      <div className="summary"><div className="row"><span>Responsable</span><span>{o.owner_name||o.admin_name||'—'}</span></div><div className="row"><span>Téléphone</span><span>{o.contact_phone||'—'}</span></div><div className="row"><span>Référence d’immatriculation</span><span>{o.registration_ref||'—'}</span></div>{o.license_reference&&<div className="row"><span>Référence du permis</span><span>{o.license_reference}</span></div>}<div className="row"><span>Demande créée</span><span>{fmtDate(o.created_at)}</span></div></div>
      <div className="controls"><button className="btn btn-primary" disabled={!online} onClick={()=>decide(o.id,'verified')}>Vérifier</button><button className="btn btn-soft" disabled={!online} onClick={()=>decide(o.id,'suspended')}>Suspendre</button><button className="btn btn-soft" disabled={!online} onClick={()=>decide(o.id,'rejected')}>Refuser</button></div>
    </Card>):<EmptyState icon={ShieldCheck} title="Aucune vérification en attente" text="Les nouvelles demandes d’opérateurs apparaîtront ici."/>}
  </div></PlatformOnly>;
}

export function PlatformFinance(){
  const health=usePlatformHealth();
  return <PlatformOnly><div className="stack"><SectionTitle title="Finances & anomalies" icon={WalletCards}/>
    {health.loading?<SkeletonCards count={3}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:<>
      <Card className="stack"><h3>Paiements échoués</h3>{(health.data.paymentAnomalies||[]).length?(health.data.paymentAnomalies||[]).map(x=><div className="row" key={x.id}><span>{x.operator_name} · {x.amount_minor} {x.currency}</span><span>{fmtDate(x.created_at)}</span></div>):<p className="small muted">Aucun paiement échoué enregistré.</p>}</Card>
      <Card className="stack"><h3>Versements échoués ou renversés</h3>{(health.data.payoutAnomalies||[]).length?(health.data.payoutAnomalies||[]).map(x=><div className="row" key={x.id}><span>{x.operator_name||'Opérateur'} · {x.beneficiary||'Bénéficiaire'} · {x.amount_minor} {x.currency}</span><span>{x.status} · {fmtDate(x.created_at)}</span></div>):<p className="small muted">Aucune anomalie de versement enregistrée.</p>}</Card>
    </>}
  </div></PlatformOnly>;
}

export function PlatformIncidents(){
  const health=usePlatformHealth();
  return <PlatformOnly><div className="stack"><SectionTitle title="Incidents plateforme" icon={TriangleAlert}/>
    {health.loading?<SkeletonCards count={3}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:(health.data.incidents||[]).length?health.data.incidents.map(i=><Card key={i.id} className="stack"><div className="between wrap"><strong>{i.operator_name} · {i.kind}</strong><Badge tone={i.severity==='high'?'danger':'warning'}>{i.severity}</Badge></div><p>{i.description||'Aucune description.'}</p><p className="small muted">{i.status} · {fmtDate(i.created_at)} · service {i.service_id}</p></Card>):<EmptyState icon={TriangleAlert} title="Aucun incident ouvert" text="Les incidents actifs de tous les opérateurs apparaîtront ici."/>}
  </div></PlatformOnly>;
}

export function PlatformSystem(){
  const health=usePlatformHealth();
  return <PlatformOnly><div className="stack"><SectionTitle title="Système & capacité" icon={Database}/>
    {health.loading?<SkeletonCards count={2}/>:health.error?<Card><p role="alert">{health.error}</p></Card>:<>
      <Card className="stack"><div className="between wrap"><strong>Base de données</strong><Badge tone={health.data.storage.registrationsOpen?'success':'warning'}>{health.data.storage.registrationsOpen?'Capacité disponible':'Nouvelles inscriptions suspendues'}</Badge></div>
        <div className="summary"><div className="row"><span>Stockage utilisé</span><span>{fmtBytes(health.data.storage.usedBytes)}</span></div><div className="row"><span>Limite configurée</span><span>{health.data.storage.limitBytes?fmtBytes(health.data.storage.limitBytes):'Non configurée'}</span></div><div className="row"><span>Utilisation</span><span>{health.data.storage.usedPercent===null?'—':`${health.data.storage.usedPercent} %`}</span></div><div className="row"><span>Seuil d’arrêt des inscriptions</span><span>{health.data.storage.registrationStopPercent} %</span></div><div className="row"><span>Inscriptions</span><span>{health.data.storage.registrationsOpen?'Ouvertes':'Suspendues'}</span></div></div></Card>
      <Card className="stack"><h3>État technique</h3><div className="summary"><div className="row"><span>Migrations</span><span>{health.data.migrations.matched?'À jour':'À vérifier'}</span></div><div className="row"><span>Notifications en échec</span><span>{health.data.counts.notification_failed}</span></div><div className="row"><span>Canaux indisponibles</span><span>{health.data.counts.notification_unavailable}</span></div><div className="row"><span>Événements à reprendre</span><span>{health.data.counts.dispatch_dead}</span></div><div className="row"><span>Échecs de routage (24h)</span><span>{health.data.counts.routing_failed}</span></div></div></Card>
    </>}
  </div></PlatformOnly>;
}

export function PlatformOperators(){
  const operators=useApi('/operators');
  return <PlatformOnly><div className="stack"><SectionTitle title="Opérateurs" icon={Building2}/>
    {operators.loading?<SkeletonCards count={4}/>:operators.error?<Card><p role="alert">{operators.error}</p></Card>:(operators.data||[]).length?operators.data.map(o=><Card key={o.id} className="between wrap"><div><strong>{o.name}</strong><p className="small muted">{o.type==='independent'?'Indépendant':'Compagnie'} · {o.country?.toUpperCase()||'—'} · créé le {new Date(o.created_at).toLocaleDateString('fr-FR')}</p></div><Badge tone={o.verification_status==='verified'?'success':'warning'}>{o.verification_status}</Badge></Card>):<EmptyState icon={Building2} title="Aucun opérateur" text="Les compagnies et indépendants enregistrés apparaîtront ici."/>}
  </div></PlatformOnly>;
}
