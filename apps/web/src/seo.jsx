import { useEffect } from 'react';
import { useLocation } from 'react-router';

const ORIGIN = 'https://leroutier.app';
const DEFAULT_IMAGE = `${ORIGIN}/icon-512.png`;

const PAGES = {
  '/': {
    title: 'LeRoutier | Transport interurbain et colis au Bénin',
    description: 'LeRoutier aide à rechercher les trajets interurbains disponibles, réserver un billet et envoyer ou suivre un colis entre les villes du Bénin.',
  },
  '/about': {
    title: 'À propos de LeRoutier | Transport au Bénin',
    description: 'Découvrez LeRoutier, plateforme béninoise pour le transport routier interurbain, la réservation de billets, le suivi des trajets et les colis.',
  },
  '/bus-benin': {
    title: 'Bus et transport interurbain au Bénin | LeRoutier',
    description: 'Recherchez les départs interurbains disponibles au Bénin, comparez les services publiés et trouvez vos points d’embarquement avec LeRoutier.',
  },
  '/cotonou-parakou': {
    title: 'Cotonou – Parakou : bus et transport | LeRoutier',
    description: 'Préparez un trajet Cotonou–Parakou : recherchez les départs disponibles, les points d’embarquement, les places et le suivi proposés sur LeRoutier.',
  },
  '/cotonou-porto-novo': {
    title: 'Cotonou – Porto-Novo : transport et bus | LeRoutier',
    description: 'Recherchez les options de transport disponibles entre Cotonou et Porto-Novo, avec points d’embarquement et informations de trajet sur LeRoutier.',
  },
  '/cotonou-bohicon': {
    title: 'Cotonou – Bohicon : bus et transport | LeRoutier',
    description: 'Recherchez les trajets disponibles entre Cotonou et Bohicon et consultez les informations d’embarquement et de voyage avec LeRoutier.',
  },
  '/cotonou-natitingou': {
    title: 'Cotonou – Natitingou : bus et transport | LeRoutier',
    description: 'Préparez votre trajet Cotonou–Natitingou en recherchant les services disponibles, les horaires publiés et les points d’embarquement sur LeRoutier.',
  },
  '/colis-benin': {
    title: 'Envoi et suivi de colis entre villes au Bénin | LeRoutier',
    description: 'Envoyez et suivez un colis entre villes du Bénin avec une référence LeRoutier, un QR code, des étapes de garde et un retrait vérifié.',
  },
  '/gares-routieres-benin': {
    title: 'Gares routières et points d’embarquement au Bénin | LeRoutier',
    description: 'Comprenez les gares routières, arrêts et points d’embarquement interurbains au Bénin et retrouvez les lieux publiés sur LeRoutier.',
  },
  '/transporteurs-benin': {
    title: 'Chauffeurs et compagnies de transport au Bénin | LeRoutier',
    description: 'LeRoutier accompagne chauffeurs indépendants et compagnies de transport au Bénin pour publier des services, gérer les passagers, les colis et l’exploitation.',
  },
};

const PRIVATE_PREFIXES = ['/work', '/ops', '/account', '/checkout', '/tickets', '/notifications', '/tracking', '/trips', '/parcels'];
const LEGAL_PATHS = ['/legal', '/privacy', '/terms', '/cancellations', '/cookies'];

function upsertMeta(selector, attrs) {
  let node = document.head.querySelector(selector);
  if (!node) {
    node = document.createElement('meta');
    document.head.appendChild(node);
  }
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
}

function upsertLink(selector, attrs) {
  let node = document.head.querySelector(selector);
  if (!node) {
    node = document.createElement('link');
    document.head.appendChild(node);
  }
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
}

export function Seo() {
  const { pathname } = useLocation();

  useEffect(() => {
    const explicit = PAGES[pathname];
    const noindex = !explicit || PRIVATE_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`)) || LEGAL_PATHS.includes(pathname);
    const page = explicit ?? {
      title: 'LeRoutier | Transport interurbain au Bénin',
      description: 'LeRoutier est une plateforme de transport interurbain et de colis au Bénin.',
    };
    const canonical = `${ORIGIN}${explicit ? pathname : '/'}`;

    document.documentElement.lang = 'fr-BJ';
    document.title = page.title;
    upsertMeta('meta[name="description"]', { name: 'description', content: page.description });
    upsertMeta('meta[name="robots"]', {
      name: 'robots',
      content: noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
    });
    upsertMeta('meta[name="googlebot"]', {
      name: 'googlebot',
      content: noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
    });
    upsertLink('link[rel="canonical"]', { rel: 'canonical', href: canonical });
    upsertLink('link[rel="alternate"][hreflang="fr-BJ"]', { rel: 'alternate', hreflang: 'fr-BJ', href: canonical });
    upsertLink('link[rel="alternate"][hreflang="x-default"]', { rel: 'alternate', hreflang: 'x-default', href: canonical });

    upsertMeta('meta[property="og:title"]', { property: 'og:title', content: page.title });
    upsertMeta('meta[property="og:description"]', { property: 'og:description', content: page.description });
    upsertMeta('meta[property="og:url"]', { property: 'og:url', content: canonical });
    upsertMeta('meta[property="og:image"]', { property: 'og:image', content: DEFAULT_IMAGE });
    upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title', content: page.title });
    upsertMeta('meta[name="twitter:description"]', { name: 'twitter:description', content: page.description });

    const id = 'leroutier-page-jsonld';
    document.getElementById(id)?.remove();
    if (!noindex) {
      const script = document.createElement('script');
      script.id = id;
      script.type = 'application/ld+json';
      script.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': pathname === '/' ? 'WebApplication' : 'WebPage',
        name: page.title.replace(' | LeRoutier', ''),
        description: page.description,
        url: canonical,
        inLanguage: 'fr-BJ',
        isPartOf: { '@id': `${ORIGIN}/#website` },
        publisher: { '@id': `${ORIGIN}/#organization` },
        ...(pathname === '/' ? {
          applicationCategory: 'TravelApplication',
          operatingSystem: 'Web',
          areaServed: { '@type': 'Country', name: 'Bénin' },
        } : {}),
      });
      document.head.appendChild(script);
    }
  }, [pathname]);

  return null;
}
