import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/**
 * Where a new page starts.
 *
 * A browser resets the scroll position when it loads a document. A single-page
 * app does not: the document never reloads, so tapping a footer link at the
 * bottom of one page left the reader at the bottom of the next one, looking at
 * ITS footer, with the heading they asked for somewhere above the viewport.
 * That is what this fixes, and it fixes it for every route rather than for the
 * link that happened to be reported.
 *
 * IT IS MOUNTED ABOVE <Routes>, in main.jsx, and that placement is the whole
 * point. The routes that carry the footer are not the same component as the
 * ones that carry the app — a legal page and the home page mount different
 * trees — so a manager inside either one would unmount at exactly the
 * navigation it exists to handle.
 *
 * FOUR CASES, and they are genuinely different:
 *
 *   - An ordinary navigation starts at the top. This is the reported bug.
 *   - A link to a fragment goes to that fragment. Resetting to the top of a
 *     page somebody asked for the middle of is the same defect mirrored.
 *   - Going BACK returns the reader to where they were. Browsers do this for
 *     real page loads, and a single-page app that always jumps to the top has
 *     silently taken it away — so the position is remembered per history
 *     entry and put back.
 *   - Going FORWARD or replacing also starts at the top; there is no position
 *     to restore that the reader has not just been shown.
 *
 * Focus moves with the page for the same reason. A route change that swaps the
 * content under a screen reader while leaving focus on a link in the old page's
 * footer leaves the reader in a document that no longer exists.
 */
export function RouteScrollReset() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const key = location.key;
  const positions = useRef(new Map());
  // Where the reader arrived, not a "have I run yet" flag.
  //
  // It was a flag, and it was wrong in a way that took a failing accessibility
  // test to see: an effect can run again on the same page — a re-render that
  // satisfies its dependencies — and the second run took the flag as
  // permission to focus the main landmark. On a cold load that is a page nobody
  // navigated to, and focus landing in the middle of it is focus stolen from
  // the top of the document, which is where a keyboard reader starts and where
  // the skip link is.
  const arrivedAt = useRef(/** @type {{here: string, key: string}|null} */ (null));
  const here = `${location.pathname}${location.search}${location.hash}`;

  // Remember where the reader was, per history entry.
  useEffect(() => {
    const save = () => positions.current.set(key, window.scrollY);
    // Saved on the way out as well as on every scroll: a reader who lands on a
    // new page without having scrolled since arriving would otherwise have no
    // entry at all, and Back would have nothing to return them to.
    window.addEventListener('scroll', save, { passive: true });
    return () => { save(); window.removeEventListener('scroll', save); };
  }, [key]);

  useEffect(() => {
    const fragment = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    const previous = arrivedAt.current;
    arrivedAt.current = { here, key };

    if (previous === null) {
      // A COLD LOAD, not a navigation. A fragment in the address is still the
      // reader's and is honoured here — the browser looked for the element
      // before React had drawn it, so a link somebody followed to
      // `/quelque-chose#section` would otherwise land at the top with nothing
      // to say why. Focus is left exactly where it is: at the top of the
      // document, which is what the skip link is the first stop of.
      if (fragment) fragment.scrollIntoView({ block: 'start' });
      return;
    }
    // The same page again, AND the same history entry. Both halves are needed:
    // the address alone would call a link to the page you are already on a
    // non-arrival — but following such a link is a navigation, and the browser
    // does it by reloading and landing at the top, so a reader who clicked it
    // expects the top. The entry alone would call a re-render an arrival. A
    // re-render is what has to be excluded, and it is the case where neither
    // has moved.
    if (previous.here === here && previous.key === key) return;

    const main = document.getElementById('lr-content');

    if (fragment) {
      // A same-page anchor is handled by the browser; this covers an anchor
      // pointing at a route that has only just rendered, where the element did
      // not exist at the moment the history entry was written.
      fragment.scrollIntoView({ block: 'start' });
      // Announcing the destination is what the fragment was for. A container
      // that cannot hold focus is left alone rather than given tabIndex it
      // does not want.
      if (fragment.hasAttribute('tabindex')) fragment.focus({ preventScroll: true });
      return;
    }

    if (navigationType === 'POP') {
      const remembered = positions.current.get(key);
      window.scrollTo({ top: remembered ?? 0, behavior: 'instant' });
    } else {
      // `instant` and not `auto`: the stylesheet sets `scroll-behavior:smooth`
      // on <html>, which is right for a link within a page and wrong for
      // arriving on one. Without it every navigation animates the whole length
      // of the page the reader just left — the reported bug, slower.
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    // Focus after the scroll, and without scrolling: the browser would
    // otherwise bring the focused element into view, which after an ordinary
    // navigation is the top of the page anyway — but after a Back it is not,
    // and the reader's restored position must not be moved by taking focus.
    main?.focus({ preventScroll: true });
  }, [here, key, navigationType, location.hash]);

  return null;
}
