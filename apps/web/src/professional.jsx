import { useNavigate } from 'react-router';
import { useSession } from '@leroutier/config/client';
import { Badge, Card, SectionTitle, status } from '@leroutier/ui';
import { Building2, Car, IdCard, ShieldCheck, Users } from 'lucide-react';

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
  const { user } = useSession();
  // Somebody who already works here does not need the sales pitch: they need
  // the way back into their own workspace.
  const workspace = user && user.role !== 'passenger'
    ? user.role === 'ops'
      ? { label: user.operator_id ? 'Ouvrir mon espace exploitation' : 'Ouvrir l’exploitation plateforme', to: user.operator_id ? '/ops/today' : '/ops/platform' }
      : { label: user.role === 'convoyeur' ? 'Ouvrir mon espace convoyeur' : 'Ouvrir mon espace chauffeur', to: '/work/today' }
    : null;
  const verification = user && user.role !== 'passenger' ? status('verification', user.verification_status) : null;

  return <div className="stack">
    <Card className="hero stack">
      <span className="eyebrow">Espace professionnel</span>
      <h1>Vous travaillez dans le transport ?</h1>
      <p>LeRoutier accueille les chauffeurs indépendants et les compagnies de transport du Bénin. Les comptes professionnels sont vérifiés avant toute activité opérationnelle ou financière.</p>
    </Card>

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
            <button className="btn btn-primary" onClick={() => navigate('/onboarding')}>{path.cta}</button>
          </div>}
        </Card>;
      })}

      <Card className="stack">
        <SectionTitle title="Comment se passe la vérification" icon={ShieldCheck}/>
        <p className="small muted" style={{ margin: 0 }}>La vérification est humaine et fondée sur les pièces que vous transmettez. LeRoutier n’effectue ni biométrie ni contrôle gouvernemental automatique, et aucun compte n’est vérifié automatiquement. Vos pièces justificatives restent privées : les voyageurs ne voient jamais vos documents d’identité.</p>
      </Card>
    </>}
  </div>;
}
