import { Link } from 'react-router';
import { Card } from '@leroutier/ui';
import { LegalFooter } from './legal.jsx';
import { CORRIDORS, CORRIDOR_BY_SLUG, CORRIDOR_NOTE } from './corridors.js';

// The direction is shown beside each pair on purpose. Eight links out of a
// single city read as the whole network; eight links labelled sud, est, ouest,
// centre and nord read as a sample of a country.
function SearchLinks() {
  return <div className="stack">
    <h2>Recherches populaires au Bénin</h2>
    <p className="muted">{CORRIDOR_NOTE}</p>
    <div className="home-actions">
      {CORRIDORS.map(corridor => <Link className="home-action" key={corridor.slug} to={`/${corridor.slug}`}>
        <span>{corridor.label}<small>{corridor.direction}</small></span>
      </Link>)}
    </div>
  </div>;
}

function InfoLayout({ children }) {
  return <main className="page stack" style={{ maxWidth: 920, margin: '0 auto', minWidth: 0 }}>
    {children}
    <LegalFooter/>
  </main>;
}

export function BusBeninPage() {
  return <InfoLayout>
    <Card className="stack">
      <span className="eyebrow">Voyager au Bénin</span>
      <h1>Bus et transport interurbain au Bénin</h1>
      <p className="lead">LeRoutier centralise la recherche de trajets interurbains publiés par des compagnies de transport et des chauffeurs indépendants, sans confondre mobilité urbaine et voyage entre villes.</p>
      <Link className="btn btn-primary" to="/">Rechercher un trajet</Link>
    </Card>
    <Card className="stack">
      <h2>Rechercher un trajet entre les villes du Bénin</h2>
      <p>Indiquez votre ville de départ, votre destination et votre date. Lorsqu’un service est publié, LeRoutier peut présenter l’opérateur, le véhicule, le point d’embarquement, l’heure de départ, le prix final et la disponibilité des places.</p>
      <p>La recherche couvre la géographie du Bénin indépendamment de l’inventaire de transport : l’absence de résultat signifie qu’aucun service correspondant n’est actuellement publié, pas que la ville n’existe pas.</p>
    </Card>
    <Card className="stack">
      <h2>Billets, embarquement et suivi du voyage</h2>
      <p>LeRoutier prend en charge la réservation numérique, le billet avec code de contrôle, l’embarquement au point exact et, lorsque le service l’active, le suivi de progression et les estimations d’arrivée.</p>
      <p>Les expressions recherchées par les voyageurs comme « bus Bénin », « transport interurbain Bénin », « billet bus en ligne Bénin », « voyage Cotonou Parakou » ou « gare routière Bénin » correspondent à des besoins que LeRoutier organise dans un même parcours.</p>
    </Card>
    <SearchLinks/>
  </InfoLayout>;
}

export function RoutePage({ slug }) {
  const route = CORRIDOR_BY_SLUG[slug];
  if (!route) return null;
  return <InfoLayout>
    <Card className="stack">
      <span className="eyebrow">Trajet interurbain</span>
      <h1>{route.h1}</h1>
      <p className="lead">{route.lead}</p>
      <Link className="btn btn-primary" to="/">Voir les départs disponibles</Link>
    </Card>
    <Card className="stack">
      <h2>Réserver un billet quand un service est disponible</h2>
      <p>LeRoutier ne fabrique pas d’horaires ni de prix. Les résultats proviennent des services réellement publiés par les opérateurs présents sur la plateforme. Vous pouvez rechercher sans créer de compte, puis vous connecter uniquement lorsque vous souhaitez transformer votre choix en réservation.</p>
    </Card>
    <Card className="stack">
      <h2>Point d’embarquement, place et informations du trajet</h2>
      <p>Un trajet LeRoutier peut préciser le point d’embarquement, l’arrêt d’arrivée, l’opérateur, le véhicule, la disponibilité par segment et les informations nécessaires avant le départ. Les données de suivi en direct sont indiquées comme telles uniquement lorsqu’un véhicule transmet une position fiable.</p>
    </Card>
    <Card className="stack">
      <h2>Ce que les voyageurs recherchent</h2>
      <p>{route.keywords.join(' · ')}</p>
    </Card>
    <SearchLinks/>
  </InfoLayout>;
}

export function ColisBeninPage() {
  return <InfoLayout>
    <Card className="stack">
      <span className="eyebrow">Expédier entre villes</span>
      <h1>Envoi et suivi de colis au Bénin</h1>
      <p className="lead">LeRoutier relie l’expéditeur, le chauffeur ou le convoyeur, l’exploitation et le destinataire autour d’une même référence de colis.</p>
      <div className="home-actions">
        <Link className="home-action" to="/parcels">Envoyer un colis</Link>
        <Link className="home-action" to="/parcels/track">Suivre un colis</Link>
      </div>
    </Card>
    <Card className="stack">
      <h2>Transport de colis interville sans obligation d’imprimer</h2>
      <p>L’expéditeur peut conserver le reçu et le QR code sur son téléphone. Si aucune imprimante n’est disponible, la référence courte du colis peut être inscrite sur l’emballage et utilisée pour l’identifier. L’impression d’une étiquette reste disponible lorsqu’un transporteur dispose du matériel nécessaire.</p>
    </Card>
    <Card className="stack">
      <h2>Suivi, garde et retrait du colis</h2>
      <p>Les étapes de prise en charge, chargement, départ, arrivée et mise à disposition sont enregistrées dans le même parcours. Le retrait par le destinataire repose sur une vérification séparée : le QR code visible sur le colis ne constitue pas à lui seul une preuve d’identité.</p>
      <p>LeRoutier vise les besoins associés aux recherches « envoi colis Bénin », « transport colis Cotonou Parakou », « livraison interville Bénin », « suivi colis Bénin » et « envoyer colis par bus au Bénin ».</p>
    </Card>
  </InfoLayout>;
}

export function StationsBeninPage() {
  return <InfoLayout>
    <Card className="stack">
      <span className="eyebrow">Avant le départ</span>
      <h1>Gares routières et points d’embarquement au Bénin</h1>
      <p className="lead">LeRoutier distingue la ville de destination du lieu concret où un passager monte ou descend du véhicule.</p>
      <Link className="btn btn-primary" to="/">Rechercher un trajet</Link>
    </Card>
    <Card className="stack">
      <h2>Un point précis plutôt qu’un simple nom de ville</h2>
      <p>Une gare routière, une station, un arrêt ou un point d’embarquement peut être associé à un trajet. Cette précision aide le voyageur à savoir où se présenter et permet à l’exploitation d’organiser correctement les montées et descentes.</p>
    </Card>
    <Card className="stack">
      <h2>Recherche de gare routière et arrêt de bus</h2>
      <p>Les recherches « gare routière Cotonou », « gare routière Parakou », « arrêt bus Cotonou », « point d’embarquement Bénin » et « station transport interurbain » renvoient au même besoin pratique : trouver le bon lieu pour prendre son service.</p>
    </Card>
  </InfoLayout>;
}

export function TransporteursBeninPage() {
  return <InfoLayout>
    <Card className="stack">
      <span className="eyebrow">Professionnels du transport</span>
      <h1>Chauffeurs indépendants et compagnies de transport au Bénin</h1>
      <p className="lead">LeRoutier permet aux opérateurs autorisés d’organiser leurs services interurbains, passagers, véhicules, équipages, points d’embarquement et colis dans un même système.</p>
      <Link className="btn btn-primary" to="/onboarding">Travailler avec LeRoutier</Link>
    </Card>
    <Card className="stack">
      <h2>Pour les chauffeurs indépendants</h2>
      <p>Un chauffeur propriétaire peut gérer son service, ses passagers, ses contrôles de billets, ses colis, ses positions de trajet et les fonctions commerciales auxquelles son rôle donne accès.</p>
    </Card>
    <Card className="stack">
      <h2>Pour les compagnies de transport</h2>
      <p>Les compagnies disposent d’un espace d’exploitation pour les lignes, arrêts, véhicules, équipages, services, incidents, colis et opérations. Les droits restent séparés entre exploitation, chauffeurs et convoyeurs.</p>
      <p>Cette page répond notamment aux recherches « compagnie transport Bénin », « chauffeur indépendant Bénin », « gestion compagnie bus Bénin », « logiciel transport routier Bénin » et « plateforme transport interurbain Bénin ».</p>
    </Card>
  </InfoLayout>;
}
