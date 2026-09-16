import { useNavigate } from 'react-router';
import { useSession } from '@leroutier/config/client';
import { Card, SectionTitle } from '@leroutier/ui';
import { TripSearchHero } from '@leroutier/screens/passenger';
import { Package, Navigation, Car, Building2 } from 'lucide-react';

// One public entry point, led by the single most important task: find a trip.
// Passenger intent dominates; operator entry is present but clearly secondary,
// and nothing here names our internal applications.
export function Home() {
  const navigate = useNavigate();
  const { user } = useSession();
  const parcelActions = [
    { icon: Package, label: 'Envoyer un colis', hint: 'Devis, dépôt et suivi', to: '/parcels' },
    { icon: Navigation, label: 'Suivre un colis', hint: 'Avec un numéro de suivi', to: '/parcels/track' },
  ];
  const workActions = [
    { icon: Car, label: 'Je suis chauffeur indépendant', hint: 'Mon véhicule, mes recettes', to: '/onboarding' },
    { icon: Building2, label: 'Je représente une compagnie', hint: 'Flotte, équipage et lignes', to: '/onboarding' },
  ];
  return <div className="stack">
    <TripSearchHero/>

    <SectionTitle title="Envoyer et suivre"/>
    <div className="home-actions">
      {parcelActions.map(action => { const Icon = action.icon; return <button key={action.label} className="home-action" onClick={() => navigate(action.to)}>
        <Icon size={20}/><span>{action.label}<small>{action.hint}</small></span>
      </button>; })}
    </div>

    <SectionTitle title="Travailler avec LeRoutier"/>
    <div className="home-actions">
      {workActions.map(action => { const Icon = action.icon; return <button key={action.label} className="home-action" onClick={() => navigate(action.to)}>
        <Icon size={20}/><span>{action.label}<small>{action.hint}</small></span>
      </button>; })}
    </div>
    {user && <Card className="stack">
      <p className="small muted">Connecté en tant que {user.display_name || 'voyageur'}. Vos espaces disponibles sont accessibles depuis l’en-tête.</p>
    </Card>}
  </div>;
}
