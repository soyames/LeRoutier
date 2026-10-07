import { useEffect, useState } from 'react';
import { Card } from './shell.jsx';
import { Logo } from './logo.jsx';

// Loading, empty and error states, in one place.
//
// Three rules the whole product follows:
//  - loading shows the shape of the answer, never invented content;
//  - an error says what failed and offers the way out;
//  - an empty state is never a dead end — it offers the next useful action.

/** @param {{ lines?: number, className?: string }} props */
export function Skeleton({ lines = 3, className = '' }) {
  return <div className={`skeleton ${className}`} aria-hidden="true">
    {Array.from({ length: lines }, (_, i) => <span key={i} className="skeleton-line" style={{ width: `${100 - i * 14}%` }}/>)}
  </div>;
}

/** Card-shaped placeholder used while a list loads. */
export function SkeletonCards({ count = 2, lines = 3 }) {
  return <div className="stack" role="status" aria-live="polite" aria-busy="true">
    <span className="sr-only">Chargement…</span>
    {Array.from({ length: count }, (_, i) => <Card key={i}><Skeleton lines={lines}/></Card>)}
  </div>;
}

/**
 * The LeRoutier mark while a region is waiting.
 *
 * IT WAITS BEFORE IT APPEARS. Most waits on a phone are over in well under a
 * tenth of a second, and a mark that appears and vanishes inside one frame reads
 * as a flicker, not as progress. The box is reserved from the first render — so
 * nothing moves when the mark fades in — but the mark itself only fades in if
 * the wait turns out to be a real one.
 *
 * IT IS NOT AN OVERLAY. It occupies its place in the layout and covers nothing,
 * so the rest of the page stays readable and usable while one region loads. A
 * full-screen scrim for a single request is how loading indicators become
 * obstacles.
 *
 * IT USES THE LOGO THE APP ALREADY HAS, at a fixed size and aspect: nothing is
 * redrawn, stretched or duplicated. Motion is a slow breath on a 180ms fade,
 * and `prefers-reduced-motion` reduces it to a still mark with no animation
 * (see the media query in styles.css).
 *
 * Skeletons are not replaced by this. Where the shape of an answer is known —
 * a list of tickets, a set of cards — the skeleton still shows it; the mark is
 * for waits whose result has no shape yet.
 *
 * @param {{ label?: string, delayMs?: number, className?: string }} props
 */
export function BrandLoader({ label = 'Chargement…', delayMs = 180, className = '' }) {
  const [visible, setVisible] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return <div className={`lr-loader ${className}`} role="status" aria-live="polite" aria-busy="true">
    <span className="lr-loader-mark" data-visible={visible ? '' : undefined} aria-hidden="true">
      <Logo compact className="lr-loader-logo"/>
    </span>
    <span className="sr-only">{label}</span>
  </div>;
}

/**
 * @typedef {import('react').ReactNode} ReactNode
 * @param {{ title?: string, text: string, onRetry?: () => void, actions?: ReactNode }} props
 */
export function ErrorState({ title = 'Chargement impossible', text, onRetry, actions }) {
  return <Card className="stack">
    <strong>{title}</strong>
    {/* Plain language: the cause belongs in logs, not on the user's screen. */}
    <p className="small muted" role="alert">{text}</p>
    <div className="controls">
      {onRetry && <button className="btn btn-primary" onClick={onRetry}>Réessayer</button>}
      {actions}
    </div>
  </Card>;
}
