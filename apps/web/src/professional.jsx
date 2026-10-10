import { useEffect,useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi, useSession } from '@leroutier/config/client';
import { Badge, Card, PageHero, PAGE_HERO, SectionTitle, status } from '@leroutier/ui';
import { Building2, Car, IdCard, ShieldCheck, Users, WalletCards } from 'lucide-react';

// The one public door for people who work in transport.
//
// It is deliberately a separate page rather than a section of the home page:
// a passenger looking for a bus should never have to read past fleet
// onboarding to find the search box. Everything here is reachable from the
// footer and from the account screen, and from nowhere more prominent.
//
// Platform Ops is absent by design. It is not something anyone registers for;
// it is granted, and the people who hold it reach it from their own account.
const PATHS = [
  {
    id: 'independent', icon: Car, title: 'Chauffeur indépendant',
    summary: 'Vous possédez votre véhicule et vous encaissez vos recettes.',
    detail: 'Vous êtes à la fois l’opérateur et le conducteur. LeRoutier vérifie donc votre identité, votre permis, votre autorisation de transport, votre assurance, votre visite technique et la carte grise du véhicule.',
    cta: 'Commencer mon dossier',
  },
  {
    id: 'company', icon: Building2, title: 'Compagnie de transport',
    summary: 'Vous gérez une flotte, un équipage et des lignes.',
    detail: 'LeRoutier vérifie l’entreprise : raison sociale, RCCM, identifiant fiscal, adresse du siège, représentant légal et autorisation de transport. Vos conducteurs salariés relèvent de votre responsabilité et n’ont aucune pièce d’identité personnelle à déposer ici.',
    cta: 'Enregistrer ma compagnie',
  },
  {
    id: 'staff', icon: Users, title: 'Conducteur ou convoyeur d’une compagnie',
    summary: 'Vous travaillez pour une compagnie déjà enregistrée.',
    detail: 'Votre accès est créé par l’exploitation de votre compagnie, puis activé avec votre propre compte LeRoutier. Vous n’avez pas de dossier à constituer vous-même : demandez à votre exploitation de vous ajouter à l’équipage.',
    cta: null,
  },
];

export function ProfessionalEntry() {
  const navigate = useNavigate();
  const { user,request,online } = useSession();
  const canManageSubscription=!!(user?.operator_id&&(user.role==='ops'||(user.role==='driver'&&user.operator_type==='independent')));
  const subscription=useApi(canManageSubscription?'/operator/subscription':null);
  const [period,setPeriod]=useState('month'),[saving,setSaving]=useState(false),[planError,setPlanError]=useState(''),[planNotice,setPlanNotice]=useState(''),[paymentProvider,setPaymentProvider]=useState('mtn_momo'),[paymentReference,setPaymentReference]=useState('');
  useEffect(()=>{if(subscription.data?.subscription.billingPeriod)setPeriod(subscription.data.subscription.billingPeriod);},[subscription.data?.subscription.billingPeriod]);
  // Somebody who already works here does not need the sales pitch: they need
  // the way back into their own workspace.
  const workspace = user && user.role !== 'passenger'
    ? user.role === 'ops'
      ? { label: user.operator_id ? 'Ouvrir mon espace exploitation' : 'Ouvrir l’exploitation plateforme', to: user.operator_id ? '/ops/today' : '/ops/platform' }
      : { label: user.role === 'convoyeur' ? 'Ouvrir mon espace convoyeur' : 'Ouvrir mon espace chauffeur', to: '/work/today' }
    : null;
  const verification = user && user.role !== 'passenger' ? status('verification', user.verification_status) : null;

  return <div className="stack">
    {/* This page had a plain card where every other public page has a
        photograph. The picture is the one the product already uses to say
        "these are the people who drive and run the services" — it is on the
        home page's professional section, and this is the page that section
        links to. */}
    {/* A band, not a paragraph: the verification detail this lead used to
        carry is already stated in full by "Comment se passe la vérification"
        below, where somebody deciding to register will actually read it. */}
    <PageHero media={PAGE_HERO.professionnels} eyebrow="Espace professionnel"
      title="Vous travaillez dans le transport ?"
      lead="LeRoutier accueille les chauffeurs indépendants et les compagnies de transport du Bénin."/>

    {workspace && <Card className="card-success stack">
      <div className="between wrap">
        <div>
          <strong>Votre compte professionnel est actif</strong>
          <p className="small muted">{user.operator_name || 'Votre activité de transport'}</p>
        </div>
        {verification?.known && <Badge tone={verification.tone}>{verification.label}</Badge>}
      </div>
      <div className="controls">
        <button className="btn btn-primary" onClick={() => navigate(workspace.to)}>{workspace.label}</button>
      </div>
    </Card>}

    {!workspace && <>
      <SectionTitle title="Choisissez votre situation" icon={IdCard}/>
      {PATHS.map(path => {
        const Icon = path.icon;
        return <Card key={path.id} className="stack">
          <div className="row"><Icon size={20} aria-hidden="true"/><h2 style={{ margin: 0, fontSize: 18 }}>{path.title}</h2></div>
          <p style={{ margin: 0 }}>{path.summary}</p>
          <p className="small muted" style={{ margin: 0 }}>{path.detail}</p>
          {path.cta && <div className="controls">
            {/* The role travels with the click. It used to be chosen twice —
                once here, once on the next screen — and the next screen only
                ever showed the generic choice, so a company that had just
                pressed "Enregistrer ma compagnie" arrived at a page asking it
                to say what it was again. */}
            <button className="btn btn-primary" onClick={() => navigate(`/onboarding?profil=${path.id}`)}>{path.cta}</button>
          </div>}
        </Card>;
      })}

    </>}

    <Card className="stack">
      <SectionTitle title="Comment se passe la vérification" icon={ShieldCheck}/>
      <p className="small muted" style={{ margin: 0 }}>La vérification est humaine et fondée sur les pièces que vous transmettez. LeRoutier n’effectue ni biométrie ni contrôle gouvernemental automatique, et aucun compte n’est vérifié automatiquement. Vos pièces justificatives restent privées : les voyageurs ne voient jamais vos documents d’identité.</p>
    </Card>

    <Card className="stack">
      <SectionTitle title="Abonnements professionnels" icon={WalletCards}/>
      <p>Les abonnements sont gratuits pendant la phase d’adoption jusqu’au <strong>30 avril 2027 inclus</strong>. Les abonnements payants commencent le <strong>1er mai 2027</strong>. Aucun débit automatique n’est promis : le renouvellement se fera par paiement manuel tant qu’un paiement récurrent avec mandat explicite n’est pas disponible.</p>
      <div className="grid grid-2">
        <div className="stack"><h3>Chauffeur indépendant</h3><p className="small">10&nbsp;000 FCFA / mois · 60&nbsp;000 FCFA / 6 mois · 120&nbsp;000 FCFA / an</p></div>
        <div className="stack"><h3>Compagnie de transport</h3><p className="small">30&nbsp;000 FCFA / mois · 180&nbsp;000 FCFA / 6 mois · 360&nbsp;000 FCFA / an</p></div>
      </div>
      {canManageSubscription&&<div className="stack">
        {subscription.data&&<p className="small" role="status">Votre formule est {subscription.data.subscription.billingStatus==='trial'?'gratuite jusqu’au 30 avril 2027':subscription.data.subscription.billingStatus==='paid'?'active jusqu’au '+new Date(subscription.data.subscription.paidThrough).toLocaleDateString('fr-BJ'):'à renouveler'}.</p>}
        <label>Choisir ma période de renouvellement<select className="control" value={period} onChange={e=>setPeriod(e.target.value)}>
          <option value="month">Mensuelle</option><option value="six_months">6 mois</option><option value="year">Annuelle</option>
        </select></label>
        {planError&&<p role="alert">{planError}</p>}{planNotice&&<p role="status">{planNotice}</p>}
        <div className="controls"><button className="btn btn-soft" disabled={saving} onClick={async()=>{setSaving(true);setPlanError('');setPlanNotice('');try{await request('/operator/subscription',{method:'POST',body:{billingPeriod:period}});await subscription.reload();setPlanNotice('Période enregistrée. Le renouvellement se fera manuellement.');}catch(e){setPlanError(e.message);}finally{setSaving(false);}}}>{saving?'Enregistrement…':'Enregistrer ma période'}</button></div>
        {subscription.data?.subscription.billingStatus==='renewal_required'&&<form className="stack" onSubmit={async e=>{e.preventDefault();setSaving(true);setPlanError('');setPlanNotice('');try{await request('/operator/subscription',{method:'POST',body:{billingPeriod:period}});const result=await request('/operator/subscription/payment',{method:'POST',body:{provider:paymentProvider,reference:paymentReference.trim()}});setPaymentReference('');setPlanNotice(`Référence ${result.reference} soumise. Les opérations vérifieront la réception avant activation.`);await subscription.reload();}catch(err){setPlanError(err.message);}finally{setSaving(false);}}}>
          <strong>Renouveler manuellement</strong>
          <p className="small muted">Effectuez le paiement hors de l’application selon les coordonnées communiquées par LeRoutier, puis soumettez la référence. L’abonnement n’est activé qu’après vérification réelle du paiement par les opérations.</p>
          <label>Moyen de paiement<select className="control" value={paymentProvider} onChange={e=>setPaymentProvider(e.target.value)}><option value="mtn_momo">MTN Mobile Money</option><option value="moov_momo">Moov Money</option><option value="fedapay">FedaPay</option><option value="bank_transfer">Virement bancaire</option><option value="cash">Espèces au bureau</option></select></label>
          <label>Référence du paiement<input className="control" required minLength={2} maxLength={150} value={paymentReference} onChange={e=>setPaymentReference(e.target.value)}/></label>
          <button className="btn btn-primary" disabled={saving||!online}>{saving?'Envoi…':'Soumettre la référence de paiement'}</button>
        </form>}
      </div>}
      <p className="small muted">Les périodes de 6 et 12 mois sont calculées au prorata exact du tarif mensuel, sans remise. Le transporteur fixe le prix du trajet et reçoit l’intégralité de ce tarif. LeRoutier ajoute au voyageur des frais de service de 2&nbsp;%. Les éventuels frais FedaPay, Mobile Money ou d’un autre prestataire sont distincts et sont affichés séparément lorsqu’ils s’appliquent.</p>
      <p className="small muted">Les frais de service LeRoutier ne sont pas remboursés en cas d’annulation. Le remboursement du tarif transporteur et l’ajustement des recettes du transporteur suivent les conditions d’annulation et la législation applicable.</p>
    </Card>
  </div>;
}
