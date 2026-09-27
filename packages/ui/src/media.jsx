// The photography the public product uses, and nothing else.
//
// Five pictures, each with exactly one job. The problem this redesign solves is
// density, so the answer is not more imagery: every file below is referenced
// from exactly one place, which is why there is no reuse helper that takes a
// slug and scatters it across cards.
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
 * One responsive photograph.
 *
 * AVIF first, then WebP, then the JPEG the browser lands on if it understands
 * neither. `priority` is for the hero only: it is the largest contentful paint,
 * so it is fetched eagerly and at high priority; everything else is lazy and
 * decoded off the main thread.
 *
 * @param {{ media: typeof MEDIA[keyof typeof MEDIA], priority?: boolean, className?: string }} props
 */
export function Photo({ media, priority = false, className }) {
  const [w, h] = media.ratio;
  const largest = media.widths[media.widths.length - 1];
  return <picture>
    <source type="image/avif" sizes={media.sizes}
      srcSet={media.widths.map(width => `/assets/${media.slug}-${width}.avif ${width}w`).join(', ')}/>
    <source type="image/webp" sizes={media.sizes}
      srcSet={media.widths.map(width => `/assets/${media.slug}-${width}.webp ${width}w`).join(', ')}/>
    <img src={`/assets/${media.slug}.jpg`} alt={media.alt} className={className}
      width={Math.min(largest, w)} height={Math.round(Math.min(largest, w) * h / w)}
      loading={priority ? 'eager' : 'lazy'} decoding={priority ? 'sync' : 'async'}
      fetchPriority={priority ? 'high' : 'auto'}/>
  </picture>;
}

