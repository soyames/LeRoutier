// The corridors LeRoutier presents as examples.
//
// THIS IS NOT THE COVERAGE. Search runs over the whole Benin geography and
// over whatever independent drivers and companies have actually published; a
// city with no page here is searched exactly like one with a page. These
// entries exist because somebody typing "bus Cotonou Malanville" into a search
// engine needs a page to land on, and because a short list in the footer has
// to look like a sample rather than a catalogue — hence the note that goes
// with it, and hence one corridor per direction instead of four out of
// Cotonou, which read as "this is all they do".
//
// Every pair below matches a real corridor in the route catalogue, so an
// operator publishing that axis has somewhere for it to appear. Adding one is
// a single entry here plus a line in public/sitemap.xml: the router, the SEO
// metadata, the footer and the in-page links all read from this list, and a
// test asserts the sitemap has not drifted from it.
export const CORRIDORS = [
  {
    slug: 'cotonou-porto-novo',
    label: 'Cotonou – Porto-Novo',
    from: 'Cotonou',
    to: 'Porto-Novo',
    direction: 'Sud',
    title: 'Cotonou – Porto-Novo : transport et bus | LeRoutier',
    description: 'Recherchez les options de transport disponibles entre Cotonou et Porto-Novo, avec points d’embarquement et informations de trajet sur LeRoutier.',
    h1: 'Transport Cotonou – Porto-Novo',
    lead: 'Préparez un déplacement interurbain entre Cotonou et Porto-Novo et consultez les services réellement publiés sur LeRoutier.',
    keywords: ['bus Cotonou Porto-Novo', 'transport Cotonou Porto-Novo', 'billet Cotonou Porto-Novo', 'voyage Cotonou Porto-Novo'],
  },
  {
    slug: 'cotonou-seme-kpodji',
    label: 'Cotonou – Sèmè-Kpodji',
    from: 'Cotonou',
    to: 'Sèmè-Kpodji',
    direction: 'Est',
    title: 'Cotonou – Sèmè-Kpodji : bus et transport | LeRoutier',
    description: 'Recherchez les services disponibles entre Cotonou et Sèmè-Kpodji, sur l’axe est du Bénin, avec points d’embarquement et informations de trajet sur LeRoutier.',
    h1: 'Transport Cotonou – Sèmè-Kpodji',
    lead: 'Axe est jusqu’à la commune frontalière du Nigéria : recherchez les services interurbains publiés entre Cotonou et Sèmè-Kpodji, avec leurs points d’embarquement.',
    keywords: ['bus Cotonou Sèmè-Kpodji', 'transport Cotonou Sèmè', 'axe est Bénin', 'transport frontière Nigéria', 'voyage Cotonou Sèmè-Kpodji'],
  },
  {
    slug: 'cotonou-lokossa',
    label: 'Cotonou – Lokossa',
    from: 'Cotonou',
    to: 'Lokossa',
    direction: 'Ouest',
    title: 'Cotonou – Lokossa : bus et transport | LeRoutier',
    description: 'Recherchez les trajets disponibles entre Cotonou et Lokossa, sur l’axe ouest par Ouidah et Comè, et consultez les informations d’embarquement sur LeRoutier.',
    h1: 'Transport Cotonou – Lokossa',
    lead: 'Axe ouest par Ouidah et Comè : consultez les services interurbains publiés entre Cotonou et Lokossa, les arrêts desservis et les places disponibles.',
    keywords: ['bus Cotonou Lokossa', 'transport Cotonou Lokossa', 'axe ouest Bénin', 'transport Mono Bénin', 'voyage Cotonou Lokossa'],
  },
  {
    slug: 'cotonou-bohicon',
    label: 'Cotonou – Bohicon',
    from: 'Cotonou',
    to: 'Bohicon',
    direction: 'Centre',
    title: 'Cotonou – Bohicon : bus et transport | LeRoutier',
    description: 'Recherchez les trajets disponibles entre Cotonou et Bohicon et consultez les informations d’embarquement et de voyage avec LeRoutier.',
    h1: 'Transport Cotonou – Bohicon',
    lead: 'Recherchez les départs disponibles entre Cotonou et Bohicon, les points de prise en charge et les informations utiles avant le voyage.',
    keywords: ['bus Cotonou Bohicon', 'transport Cotonou Bohicon', 'billet Cotonou Bohicon', 'voyage Cotonou Bohicon'],
  },
  {
    slug: 'cotonou-parakou',
    label: 'Cotonou – Parakou',
    from: 'Cotonou',
    to: 'Parakou',
    direction: 'Centre',
    title: 'Cotonou – Parakou : bus et transport | LeRoutier',
    description: 'Préparez un trajet Cotonou–Parakou : recherchez les départs disponibles, les points d’embarquement, les places et le suivi proposés sur LeRoutier.',
    h1: 'Transport Cotonou – Parakou',
    lead: 'Recherchez les services interurbains publiés entre Cotonou et Parakou, avec points d’embarquement, places disponibles et informations de trajet.',
    keywords: ['bus Cotonou Parakou', 'transport Cotonou Parakou', 'billet Cotonou Parakou', 'voyage Cotonou Parakou', 'gare Cotonou Parakou'],
  },
  {
    slug: 'cotonou-natitingou',
    label: 'Cotonou – Natitingou',
    from: 'Cotonou',
    to: 'Natitingou',
    direction: 'Nord-Ouest',
    title: 'Cotonou – Natitingou : bus et transport | LeRoutier',
    description: 'Préparez votre trajet Cotonou–Natitingou en recherchant les services disponibles, les horaires publiés et les points d’embarquement sur LeRoutier.',
    h1: 'Transport Cotonou – Natitingou',
    lead: 'Consultez les services publiés entre Cotonou et Natitingou, les arrêts, les places et les informations opérationnelles disponibles sur LeRoutier.',
    keywords: ['bus Cotonou Natitingou', 'transport Cotonou Natitingou', 'billet Cotonou Natitingou', 'voyage Cotonou Natitingou'],
  },
  {
    slug: 'cotonou-malanville',
    label: 'Cotonou – Malanville',
    from: 'Cotonou',
    to: 'Malanville',
    direction: 'Nord',
    title: 'Cotonou – Malanville : bus et transport | LeRoutier',
    description: 'Préparez un trajet Cotonou–Malanville sur l’axe nord du Bénin : services publiés, points d’embarquement, segments et informations de voyage sur LeRoutier.',
    h1: 'Transport Cotonou – Malanville',
    lead: 'Axe nord complet, jusqu’à la frontière du Niger : recherchez les services publiés entre Cotonou et Malanville et les points d’embarquement de chaque segment.',
    keywords: ['bus Cotonou Malanville', 'transport Cotonou Malanville', 'axe nord Bénin', 'transport frontière Niger', 'voyage Cotonou Malanville'],
  },
  {
    // Deliberately not out of Cotonou. Most of the country's travel is not,
    // and a list that never leaves the capital says the opposite.
    slug: 'parakou-natitingou',
    label: 'Parakou – Natitingou',
    from: 'Parakou',
    to: 'Natitingou',
    direction: 'Nord',
    title: 'Parakou – Natitingou : bus et transport | LeRoutier',
    description: 'Recherchez les services disponibles entre Parakou et Natitingou par Djougou, avec points d’embarquement et informations de trajet sur LeRoutier.',
    h1: 'Transport Parakou – Natitingou',
    lead: 'Tous les trajets ne partent pas de Cotonou : recherchez les services interurbains publiés entre Parakou et Natitingou, par Djougou.',
    keywords: ['bus Parakou Natitingou', 'transport Parakou Natitingou', 'voyage Parakou Natitingou', 'transport nord Bénin', 'bus Djougou'],
  },
];

// Said wherever the sample is shown, because four or eight named pairs look
// like a timetable unless something says otherwise.
export const CORRIDOR_NOTE = 'Quelques axes parmi d’autres. La recherche couvre tout le Bénin, y compris les trajets publiés par les chauffeurs indépendants.';

export const CORRIDOR_BY_SLUG = Object.fromEntries(CORRIDORS.map(c => [c.slug, c]));
