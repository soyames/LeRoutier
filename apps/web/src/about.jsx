import { LegalFooter } from './legal.jsx';
import { Link } from 'react-router';

// Public positioning. LeRoutier is a digital operating and transaction
// platform for interurban road transport and parcel mobility in Benin —
// not merely an online ticket website. Every claim here is verifiable in
// the product; nothing overpromises delivery, GPS or payment outcomes.

function Section({ title, children }) {
  return <section className="stack about-section"><h2>{title}</h2>{children}</section>;
}

export function About() {
  return <main className="page stack" style={{ maxWidth: 920, margin: '0 auto', minWidth: 0 }}>
    <header className="stack">
      <img className="about-hero" src="/about-hero.svg" alt="Bus interurbain LeRoutier reliant des villes du Bénin, avec un colis et un repère de position" width="960" height="360"/>
      <h1>À propos de LeRoutier</h1>
      <p className="lead">LeRoutier est la plateforme numérique d’exploitation et de transaction du transport routier interurbain et de la mobilité par colis au Bénin.</p>
    </header>

    <Section title="Ce que fait LeRoutier">
      <p>LeRoutier relie les voyageurs, les compagnies de transport, les chauffeurs indépendants, les équipages, les colis, les lignes, les paiements, le suivi en direct et la gestion opérationnelle dans une seule plateforme.</p>
      <p>Les voyageurs recherchent des départs, réservent un billet en ligne au tarif affiché, suivent leur voyage et envoient des colis. Les compagnies et les chauffeurs indépendants gèrent leurs lignes, leurs tarifs, leurs services, leurs équipages, leurs colis, leurs incidents et leur activité — avec une assistance intelligente qui s’appuie uniquement sur les données réelles de la plateforme.</p>
    </Section>

    <Section title="Qui sert LeRoutier">
      <ul>
        <li><strong>Voyageurs</strong> : recherche de trajets, réservation en ligne, billet électronique, suivi du voyage et notifications.</li>
        <li><strong>Compagnies de transport</strong> : gestion des lignes et services, des équipages, des colis, des paiements et des règlements.</li>
        <li><strong>Chauffeurs indépendants</strong> : gestion de leur propre activité, vente au comptant, recettes et retraits.</li>
        <li><strong>Équipages</strong> : manifeste passagers, contrôle des billets, vente au comptant, prise en charge des colis.</li>
        <li><strong>Expéditeurs et destinataires de colis</strong> : envoi standard ou express, suivi public par numéro, retrait sécurisé par code.</li>
      </ul>
    </Section>

    <Section title="Les services de la plateforme">
      <ul>
        <li><strong>Réservation numérique</strong> : un billet confirmé uniquement après un paiement vérifié.</li>
        <li><strong>Tarifs finaux affichés</strong> : le prix publié par l’opérateur est le prix total payé par le client.</li>
        <li><strong>Suivi de voyage en direct</strong> : la position du véhicule et l’heure d’arrivée estimée lorsque le service les transmet réellement.</li>
        <li><strong>Colis standard et express</strong> : l’express n’est proposé que lorsqu’un départ du jour peut réellement livrer le jour même.</li>
        <li><strong>Intelligence tarifaire</strong> : un outil consultatif réservé aux opérateurs pour comparer leurs tarifs au marché observé ; l’opérateur reste responsable du tarif final.</li>
        <li><strong>Accès USSD prévu</strong> : la réservation par téléphone simple est préparée pour les voyageurs sans smartphone, dans l’attente des autorisations réglementaires.</li>
        <li><strong>Assistance intelligente</strong> : un assistant intégré répond à partir des données réelles — il n’invente jamais une place, un tarif ou une heure.</li>
      </ul>
    </Section>

    <Section title="Ce sur quoi vous pouvez compter">
      <ul>
        <li>Les tarifs affichés sont les prix finaux client ; les conditions commerciales des opérateurs sont publiées dans nos <Link to="/terms">conditions d’utilisation</Link>.</li>
        <li>L’exécution du transport reste la responsabilité de l’opérateur identifié sur votre réservation ; LeRoutier assure la coordination numérique et transactionnelle.</li>
        <li>Les informations en direct (position, arrivée estimée) dépendent de la disponibilité réelle du GPS et du service ; une estimation n’est jamais présentée comme une garantie.</li>
        <li>Les suggestions de premier ou dernier kilomètre sont des propositions externes, jamais des engagements de LeRoutier.</li>
        <li>Un paiement n’est confirmé qu’après vérification par le prestataire de paiement, et un remboursement ne dépend jamais d’une simple instruction automatique.</li>
      </ul>
    </Section>

    <Section title="Éditeur">
      <p>LeRoutier est exploité par <strong>DIGITAL CONDORDIA</strong>, entreprise immatriculée au Registre du Commerce et du Crédit Mobilier d’Abomey-Calavi sous le numéro RB/ABC/21 A 28773, Bénin. Voir les <Link to="/legal">mentions légales</Link>.</p>
    </Section>

    <LegalFooter/>
  </main>;
}
