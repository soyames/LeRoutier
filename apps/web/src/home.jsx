import { useNavigate } from 'react-router';
import { useSession } from '@leroutier/config/client';
import { Card, SectionTitle } from '@leroutier/ui';
import { Search, Package, Navigation, Car, Building2 } from 'lucide-react';

// One public entry point. It speaks in tasks — travel, send, track, drive,
// manage — not in application names: a visitor never needs to know that
// Passenger, Driver and Ops exist as separate ideas.
export function Home() {
  const navigate = useNavigate();
  const { user } = useSession();
  const actions = [
    { icon: Search, label: 'Rechercher un trajet', hint: 'Sans compte — connexion seulement pour réserver', to: '/trips' },
    { icon: Package, label: 'Envoyer un colis', hint: 'Devis, dépôt et suivi', to: '/parcels' },
    { icon: Navigation, label: 'Suivre un colis', hint: 'Avec un numéro de suivi', to: '/tracking' },
    { icon: Car, label: 'Conduire avec LeRoutier', hint: 'Chauffeur indépendant propriétaire', to: '/onboarding' },
    { icon: Building2, label: 'Gérer une compagnie', hint: 'Compagnie de transport', to: '/onboarding' },
  ];
  return <div className="stack">
    <Card className="hero stack">
      <span className="eyebrow">LeRoutier</span>
      <h1>Voyagez et expédiez entre les villes du Bénin.</h1>
      <p>
        Recherchez un départ librement. Le compte n’est demandé qu’au moment de réserver, de payer
        ou de suivre vos envois. Points d’embarquement exacts, paiement en ligne sécurisé.
      </p>
    </Card>
    <SectionTitle title="Que voulez-vous faire ?"/>
    <div className="home-actions">
      {actions.map(action => { const Icon = action.icon; return <button key={action.label} className="home-action" onClick={() => navigate(action.to)}>
        <Icon size={20}/><span>{action.label}<small>{action.hint}</small></span>
      </button>; })}
    </div>
    {user && <p className="small muted">Connecté en tant que {user.display_name || 'voyageur'}. Vos espaces disponibles apparaissent en haut de l’écran.</p>}
  </div>;
}
