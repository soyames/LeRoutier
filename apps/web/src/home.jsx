import { Link, useNavigate } from 'react-router';
import { useSession } from '@leroutier/config/client';
import { Card, SectionTitle } from '@leroutier/ui';
import { TripSearchHero } from '@leroutier/screens/passenger';
import { Package, Navigation, MessagesSquare } from 'lucide-react';
import { LegalFooter } from './legal.jsx';
import { CORRIDORS } from './corridors.js';

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
  return <div className="stack">
    {/* The same catalogue the footer lists under "Destinations populaires".
        The search chips and the footer are two views of one answer to "where
        do people go", so they cannot disagree. */}
    <TripSearchHero corridors={CORRIDORS}/>

    <SectionTitle title="Envoyer et suivre"/>
    <div className="home-actions">
      {parcelActions.map(action => { const Icon = action.icon; return <button key={action.label} className="home-action" onClick={() => navigate(action.to)}>
        <Icon size={20}/><span>{action.label}<small>{action.hint}</small></span>
      </button>; })}
    </div>

    {/* Professional access stays available, but as one quiet line rather than a
        top-level section competing with the trip search. */}
    <p className="small muted home-professional">
      Vous travaillez dans le transport ? <Link to="/professionnel">Espace professionnel</Link>
    </p>

    {/* These two cards were a wall of link text doing a job a conversation does
        better: a visitor with a question about a corridor, a gare or a parcel
        now asks it and gets an answer from real published services. The pages
        themselves still exist and stay linked from the footer. */}
    <Card className="assistant-invite stack">
      <div className="row"><MessagesSquare size={20} aria-hidden="true"/><h2 style={{ margin: 0, fontSize: 18 }}>Une question sur votre trajet ?</h2></div>
      <p style={{ margin: 0 }}>Demandez les départs réellement publiés entre deux villes, un tarif, le suivi d’un colis ou l’état de votre réservation. L’assistant répond à partir des services réels : jamais d’un horaire inventé.</p>
      <div className="controls">
        <button className="btn btn-primary" onClick={() => window.dispatchEvent(new Event('leroutier:assistant-open'))}>
          <MessagesSquare size={16} aria-hidden="true"/>Ouvrir l’assistant</button>
      </div>
    </Card>

    {user && <Card className="stack">
      <p className="small muted">Connecté en tant que {user.display_name || 'voyageur'}. Vos espaces disponibles sont accessibles depuis l’en-tête.</p>
    </Card>}
    <LegalFooter/>
  </div>;
}
