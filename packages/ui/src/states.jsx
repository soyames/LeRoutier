import { Card } from './shell.jsx';

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
