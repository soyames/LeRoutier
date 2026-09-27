// The photography the public product uses, and nothing else.
//
// Five pictures, each with exactly one subject. The problem this redesign
// solves is density, so the answer is not more imagery: every file below is
// referenced from a named surface rather than scattered across cards.
//
// Delivery. Each source arrived as a ~2 MB generated PNG. A phone should not
// download 2 MB to look at a bus, so every one is re-encoded to AVIF and WebP
// at the two widths the layout actually requests, with an optimised JPEG as
// the fallback for a user agent that negotiates neither. The originals are not
// shipped: nothing references a PNG from this directory.
//
// `widths` are the responsive steps; `sizes` is the layout width the browser
// should assume at each breakpoint. Getting `sizes` wrong makes the browser
// pick the wrong step, which is the usual way a srcset quietly costs more than
// a single image would have.
//
// This lives in a plain .js file rather than beside the component because the
// browser suite reads it to assert that every declared file exists on disk —
// and a test cannot import JSX.
export const MEDIA = {
  hero: {
    slug: 'leroutier-hero-benin-intercity',
    widths: [640, 1280],
    // Full-bleed band, so the browser is told the viewport width.
    sizes: '100vw',
    // Intrinsic size of the delivered source. Declared on the <img> so the box
    // is reserved before the bytes arrive and the page never shifts.
    ratio: [1448, 1086],
    alt: 'Voyageurs montant dans un autocar interurbain au Bénin',
  },
  voyager: {
    slug: 'leroutier-service-voyager',
    widths: [480, 900],
    sizes: '(min-width: 1000px) 360px, (min-width: 700px) 45vw, 92vw',
    ratio: [1672, 941],
    alt: 'Voyageurs chargeant leurs bagages dans un car interurbain',
  },
  colis: {
    slug: 'leroutier-service-colis',
    widths: [480, 900],
    sizes: '(min-width: 1000px) 360px, (min-width: 700px) 45vw, 92vw',
    ratio: [1448, 1086],
    alt: 'Remise d’un colis à un agent, devant un véhicule utilitaire',
  },
  suivi: {
    slug: 'leroutier-live-tracking',
    widths: [640, 1100],
    sizes: '(min-width: 1000px) 360px, (min-width: 700px) 45vw, 92vw',
    ratio: [1448, 1086],
    alt: 'Voyageuse consultant le suivi de son trajet sur son téléphone à l’arrêt',
  },
  professionnels: {
    slug: 'leroutier-professionnels',
    widths: [640, 1100],
    sizes: '(min-width: 860px) 50vw, 100vw',
    ratio: [1448, 1086],
    alt: 'Conducteur d’autocar et agent d’exploitation devant leur véhicule',
  },
};

/**
 * The band hero used by the public entry pages other than the home page.
 *
 * Each of these pictures is also somewhere on the home page, but never twice
 * on the same page: the home hero is the boarding photograph, the home
 * tracking section has no picture at all precisely because the Suivre service
 * card already shows this one, and each entry page gets the picture that is
 * about it. `sizes` here is the band width, not the viewport.
 */
export const PAGE_HERO = {
  trips: { ...MEDIA.hero, sizes: '(min-width: 1220px) 1180px, 100vw' },
  tracking: { ...MEDIA.suivi, sizes: '(min-width: 1220px) 1180px, 100vw' },
  professionnels: { ...MEDIA.professionnels, sizes: '(min-width: 1220px) 1180px, 100vw' },
};

/** Every file a slug is expected to have on disk, for the asset test. */
export const mediaFiles = media => [
  ...media.widths.flatMap(width => [`${media.slug}-${width}.avif`, `${media.slug}-${width}.webp`]),
  `${media.slug}.jpg`,
];
