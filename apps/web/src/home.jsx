import { Link, useNavigate } from 'react-router';
import { useSession } from '@leroutier/config/client';
import { Card, SectionTitle } from '@leroutier/ui';
import { TripSearchHero } from '@leroutier/screens/passenger';
import { Package, Navigation, Car, Building2 } from 'lucide-react';
import { LegalFooter } from './legal.jsx';

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

    <Card className="stack">
      <h2 style={{ margin: 0 }}>Transport interurbain au Bénin</h2>
      <p style={{ margin: 0 }}>LeRoutier aide les voyageurs à rechercher les services de transport réellement publiés entre les villes du Bénin. La plateforme réunit la recherche de trajet, les points d’embarquement, les billets, le suivi du voyage et les colis sans transformer l’absence d’offre en faux horaire.</p>
      <div className="home-actions">
        <Link className="home-action" to="/bus-benin">Bus et transport au Bénin</Link>
        <Link className="home-action" to="/cotonou-parakou">Cotonou – Parakou</Link>
        <Link className="home-action" to="/cotonou-porto-novo">Cotonou – Porto-Novo</Link>
        <Link className="home-action" to="/cotonou-bohicon">Cotonou – Bohicon</Link>
        <Link className="home-action" to="/cotonou-natitingou">Cotonou – Natitingou</Link>
      </div>
    </Card>

    <Card className="stack">
      <h2 style={{ margin: 0 }}>Colis, gares routières et transporteurs</h2>
      <p style={{ margin: 0 }}>LeRoutier couvre aussi l’envoi et le suivi de colis entre villes, les points d’embarquement ainsi que les outils destinés aux chauffeurs indépendants et aux compagnies de transport.</p>
      <div className="home-actions">
        <Link className="home-action" to="/colis-benin">Envoi et suivi de colis au Bénin</Link>
        <Link className="home-action" to="/gares-routieres-benin">Gares routières et points d’embarquement</Link>
        <Link className="home-action" to="/transporteurs-benin">Chauffeurs et compagnies de transport</Link>
      </div>
    </Card>

    {user && <Card className="stack">
      <p className="small muted">Connecté en tant que {user.display_name || 'voyageur'}. Vos espaces disponibles sont accessibles depuis l’en-tête.</p>
    </Card>}
    <LegalFooter/>
  </div>;
}
