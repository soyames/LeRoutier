// Turning a screen into something a feature phone will actually display.
//
// A USSD response has a hard length limit — 182 characters on GSM 03.38 is the
// safe common denominator. Exceeding it does not wrap: the gateway truncates,
// and what gets cut is the end of the screen, which is exactly where the
// navigation options live. A truncated screen is a dead end.
//
// So pagination is a first-class concern here, not an afterthought: when a list
// does not fit, it is split, never trimmed.

export const MAX_RESPONSE_CHARS = 182;

/** GSM 03.38 charges two characters for a few symbols; count what the gateway counts. */
const EXTENDED = new Set(['|', '^', '€', '{', '}', '[', ']', '~', '\\']);
export function gsmLength(text) {
  let total = 0;
  for (const char of String(text)) total += EXTENDED.has(char) ? 2 : 1;
  return total;
}

/**
 * Builds one screen: a title, some body lines, then the navigation options.
 *
 * Navigation is appended last but protected first — the budget is reserved for
 * it before any body line is considered, because a caller who cannot go back is
 * stuck until the session times out.
 */
export function screen({ title = '', lines = [], nav = [], limit = MAX_RESPONSE_CHARS }) {
  const navText = nav.filter(Boolean).join('\n');
  const reserved = navText ? gsmLength(navText) + 1 : 0;
  const head = title ? `${title}\n` : '';
  let out = head;
  const kept = [];
  for (const line of lines.filter(Boolean)) {
    const candidate = kept.length ? `${out}${line}\n` : `${out}${line}\n`;
    if (gsmLength(candidate) + reserved > limit) break;
    out = candidate;
    kept.push(line);
  }
  return `${out}${navText}`.trim();
}

/**
 * Splits items into pages that fit, with the navigation they need.
 *
 * The page size is computed from the real rendered length rather than a guessed
 * item count, because "1. Cotonou" and "3. Dassa-Zoumè – Gare routière" are not
 * the same size and a fixed count would either waste a screen or overflow one.
 */
/**
 * @param {any[]} items
 * @param {{ page?: number, title?: string, nav?: string[], limit?: number,
 *   render?: (item: any, index: number) => string }} [options]
 */
export function paginate(items, { page = 0, title = '', nav = [], limit = MAX_RESPONSE_CHARS, render = String } = {}) {
  const rendered = items.map(render);
  const pages = [];
  let current = [];
  let currentIndex = 0;

  // Assume the busiest navigation this list could need, so adding a "next"
  // option on the last page can never push it over.
  const navPreview = [...nav, '#. Suivant', '*. Précédent'].filter(Boolean).join('\n');

  for (let i = 0; i < rendered.length; i++) {
    // Measured directly, NOT through screen(): screen already enforces the
    // limit by dropping lines, so asking it how long a page would be always
    // gets an answer under the limit — and the list would never split.
    const attempt = [title, ...current, rendered[i], navPreview].filter(Boolean).join('\n');
    if (current.length && gsmLength(attempt) > limit) {
      pages.push({ lines: current, from: currentIndex, to: i - 1 });
      current = [rendered[i]];
      currentIndex = i;
    } else {
      current.push(rendered[i]);
    }
  }
  if (current.length || !pages.length) pages.push({ lines: current, from: currentIndex, to: rendered.length - 1 });

  const index = Math.max(0, Math.min(page, pages.length - 1));
  const chosen = pages[index];
  return {
    page: index,
    pageCount: pages.length,
    lines: chosen.lines,
    // The slice of the original items this page shows, so a selection maps back
    // to the right record rather than to the right position on screen.
    items: items.slice(chosen.from, chosen.to + 1),
    offset: chosen.from,
    hasNext: index < pages.length - 1,
    hasPrevious: index > 0,
  };
}

/**
 * A last line of defence.
 *
 * Nothing should reach a gateway over the limit, but if a bug ever produces an
 * oversized screen it is better to send a short, honest failure than a silently
 * truncated menu whose options have been cut off.
 */
/**
 * Puts a notice above a screen without pushing the screen over the limit.
 *
 * "Choix invalide" prepended to a full list is how a caller loses the options
 * they were about to choose from. So the screen is rendered with the notice's
 * length already reserved; this only assembles the two and, if a caller-facing
 * screen still would not fit, keeps the *screen* — being told the choice was
 * invalid is no use without the choices.
 */
export function withNotice(text, notice, limit = MAX_RESPONSE_CHARS) {
  if (!notice) return text;
  const combined = `${notice}\n${text}`;
  return gsmLength(combined) <= limit ? combined : text;
}

export function enforceLimit(text, limit = MAX_RESPONSE_CHARS, fallback = 'Service momentanément indisponible.') {
  const value = String(text ?? '');
  if (gsmLength(value) <= limit) return value;
  return gsmLength(fallback) <= limit ? fallback : fallback.slice(0, limit);
}
