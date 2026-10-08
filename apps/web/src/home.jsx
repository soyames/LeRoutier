import { Link } from 'react-router';
import { JourneySearch } from '@leroutier/screens/passenger';
import { MEDIA, Photo } from '@leroutier/ui';
import { ArrowRight, Search, Ticket, QrCode, Navigation, Package } from 'lucide-react';

// The public homepage.
//
// Six sections, one job each, and the page is built so that the reader is
// never asked to hold two ideas at once:
//
//   hero → search → services → how → tracking → professionals
//
// What used to be here: a hero card carrying an eyebrow, a title, a subtitle,
// the search form, a corridor row, a note about fares and a note about
// accounts; then two link rows; then a full-width assistant invitation card
// with a paragraph and a button. Nine blocks of text and two competing primary
// actions above the first photograph. Now the hero says one sentence, the
// search panel asks three questions, and the assistant is a quiet pill in the
// corner that nobody has to read.

const SERVICES = [
  {
    key: 'voyager',
    to: '/trips',
    title: 'Voyager',
    text: 'Trouvez les départs disponibles entre les villes du Bénin.',
    cta: 'Rechercher un trajet',
  },
  {
    key: 'colis',
    to: '/parcels',
    title: 'Envoyer un colis',
    text: 'Confiez votre colis à un trajet et suivez son acheminement.',
    cta: 'Envoyer un colis',
  },
  {
    key: 'suivi',
    to: '/tracking',
    title: 'Suivre',
    text: 'Retrouvez la progression de votre trajet ou de votre colis.',
    cta: 'Suivre',
  },
];

// Four steps, four sentences, no photographs and no card around each one.
// A numbered row on a soft band is enough structure for four short ideas.
const HOW_STEPS = [
  { icon: Search, title: 'Recherchez', text: 'Choisissez votre départ, votre destination et votre date.' },
  { icon: Ticket, title: 'Réservez', text: 'Sélectionnez le trajet qui vous convient.' },
  { icon: QrCode, title: 'Embarquez', text: 'Présentez votre billet QR au départ.' },
  { icon: Navigation, title: 'Suivez', text: 'Retrouvez les étapes de votre voyage en temps réel.' },
];

export function Home() {
  return <>
    {/* 1 — HERO. A photograph and one sentence. The headline is the page's
        only <h1>; the search panel below carries its own question as an <h2>,
        so the two never compete for the same rank. */}
    <section className="hero" aria-labelledby="home-title">
      <div className="hero-media">
        <Photo media={MEDIA.hero} priority/>
        <div className="hero-inner">
          <div className="hero-copy">
            <span className="eyebrow">Mobilité Interurbaine</span>
            <h1 id="home-title">Voyagez entre les villes, simplement.</h1>
            <p>Réservez votre trajet, envoyez un colis et suivez votre mobilité interurbaine avec LeRoutier.</p>
          </div>
        </div>
      </div>
    </section>

    {/* 2 — SEARCH. The one thing the page is for. */}
    <div className="lr-section hero-search">
      <JourneySearch/>
    </div>

    {/* 3 — MAIN SERVICES. Three pictures with a door in each. */}
    <section className="lr-section" aria-labelledby="services-title">
      <div className="section-head">
        <span className="eyebrow">Services</span>
        <h2 id="services-title">Trois façons d’utiliser LeRoutier</h2>
      </div>
      <div className="service-grid">
        {SERVICES.map(service => <article key={service.key} className="service-card">
          <div className="service-card-media"><Photo media={MEDIA[service.key]}/></div>
          <div className="service-card-body">
            <h3>{service.title}</h3>
            <p>{service.text}</p>
            {/* A link, not a button: it goes somewhere. It also keeps the
                search form's "Rechercher un trajet" the only button by that
                name on the page, which is what a screen reader user hears
                when they list the buttons. */}
            <Link className="service-card-link" to={service.to}>
              {service.cta}<ArrowRight size={16} aria-hidden="true"/>
            </Link>
          </div>
        </article>)}
      </div>
    </section>

    {/* 4 — HOW IT WORKS. */}
    <section className="lr-section" aria-labelledby="how-title">
      <div className="steps-band">
        <div className="section-head">
          <span className="eyebrow">Comment ça marche</span>
          <h2 id="how-title">Quatre étapes, du départ à l’arrivée</h2>
        </div>
        <ol className="how-steps" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {HOW_STEPS.map((step, index) => { const Icon = step.icon; return <li key={step.title} className="how-step">
            <span className="how-num" aria-hidden="true">{index + 1}</span>
            <strong><Icon size={16} aria-hidden="true" style={{ verticalAlign: '-3px', marginRight: 6, color: 'var(--primary-strong)' }}/>{step.title}</strong>
            <p>{step.text}</p>
          </li>; })}
        </ol>
      </div>
    </section>

    {/* 5 — LIVE TRACKING. Deliberately has no photograph: the tracking picture
        is already on the screen above, in the Suivre service card, and the
        brief is explicit that the same large image may not appear twice on one
        page. The section carries its weight with one sentence and one action. */}
    <section className="lr-section" aria-labelledby="tracking-title">
      <div className="feature-band is-dark">
        <div className="feature-band-copy">
          <span className="eyebrow" style={{ color: '#ffd0a6' }}>Suivi</span>
          <h2 id="tracking-title" style={{ color: '#fff' }}>Suivez votre trajet en temps réel</h2>
          <p>Les étapes de votre voyage s’affichent à mesure qu’elles sont confirmées. Rien n’est estimé quand l’information n’existe pas.</p>
          <div className="controls">
            <Link className="btn btn-primary" to="/tickets">Voir mes trajets</Link>
            <Link className="btn btn-soft" to="/parcels/track" style={{ background: 'transparent', color: '#fff', borderColor: 'rgba(255,255,255,.32)' }}>
              <Package size={16} aria-hidden="true"/>Suivre un colis
            </Link>
          </div>
        </div>
      </div>
    </section>

    {/* 6 — PROFESSIONALS. Last, and quieter than the search: it is a real
        product path, but nobody came here for it. */}
    <section className="lr-section" aria-labelledby="pro-title">
      <div className="feature-band media-right">
        <div className="feature-band-media"><Photo media={MEDIA.professionnels}/></div>
        <div className="feature-band-copy">
          <span className="eyebrow">Professionnels</span>
          <h2 id="pro-title">Vous transportez déjà des voyageurs ?</h2>
          <p>Conducteur indépendant, compagnie de transport ou convoyeur : rejoignez LeRoutier.</p>
          <div className="controls">
            <Link className="btn btn-primary" to="/professionnel">Découvrir l’espace professionnel</Link>
          </div>
        </div>
      </div>
    </section>
  </>;
}
