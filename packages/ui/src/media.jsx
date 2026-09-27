import { MEDIA, PAGE_HERO, mediaFiles } from './media-assets.js';

export { MEDIA, PAGE_HERO, mediaFiles };

/**
 * One responsive photograph.
 *
 * AVIF first, then WebP, then the JPEG the browser lands on if it understands
 * neither. `priority` is for a hero only: it is the largest contentful paint,
 * so it is fetched eagerly and at high priority; everything else is lazy and
 * decoded off the main thread.
 *
 * `alt` is never empty by accident. A photograph that carries meaning gets a
 * sentence describing its purpose rather than its contents; one that is purely
 * decorative would pass `alt=""` explicitly, and there are none in this
 * product — every picture here is answering a question.
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

/**
 * The photographic band that opens a public page.
 *
 * The home page's hero is full-bleed because it is the front door; every other
 * public page — trips, tracking, parcels, professionals — opens with this
 * band inside the product container. Same picture language, same scrim, same
 * copy rules, one component, so a page that grows a hero grows the right one.
 *
 * The heading is the page's only <h1>: a page that renders this must not
 * render a second one.
 *
 * @param {{ media: typeof MEDIA[keyof typeof MEDIA], eyebrow?: string, title: string, lead?: string, children?: any, priority?: boolean }} props
 */
export function PageHero({ media, eyebrow, title, lead, children, priority = true }) {
  return <section className="page-hero" aria-labelledby="page-hero-title">
    <Photo media={media} priority={priority}/>
    <div className="page-hero-inner">
      <div className="page-hero-copy">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 id="page-hero-title">{title}</h1>
        {lead && <p>{lead}</p>}
        {children && <div className="controls">{children}</div>}
      </div>
    </div>
  </section>;
}
