// The vocabulary every model provider fails in.
//
// Its own module so the token source and the providers can both speak it
// without importing each other. A reason code is the only thing a failure is
// allowed to carry outwards: provider messages routinely quote the request,
// which for a token exchange means the credential that was being exchanged.

/** A provider failure that is safe to surface and to store. */
export class ModelUnavailable extends Error {
  /**
   * @param {string} reason one of MODEL_REASONS
   * @param {string} [detail] safe to log; never contains a credential or a URL
   * @param {number|null} [retryAfterMs] how long the provider itself asked to
   *   be left alone. Google says so in a `Retry-After` header and again in a
   *   `RetryInfo` detail; honouring it beats guessing a cooldown.
   */
  constructor(reason, detail = '', retryAfterMs = null) {
    super(detail || reason);
    this.name = 'ModelUnavailable';
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * How long a provider asked to be left alone, from whichever place it said so.
 *
 * `Retry-After` is either seconds or an HTTP date. Google *also* puts a
 * `RetryInfo` detail in the error body with a duration like `"57s"`, and in
 * practice the two do not always both appear — so both are read, and the
 * longer wins. Anything absurd is ignored rather than trusted: a provider
 * asking for a week is a provider LeRoutier has misread.
 */
export function retryAfterMs(response, body) {
  const capped = ms => (Number.isFinite(ms) && ms > 0 && ms <= 6 * 3600_000 ? Math.round(ms) : null);
  const candidates = [];

  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    candidates.push(Number.isFinite(seconds) ? capped(seconds * 1000) : capped(Date.parse(header) - Date.now()));
  }

  for (const detail of body?.error?.details ?? []) {
    if (!String(detail?.['@type'] ?? '').endsWith('RetryInfo')) continue;
    const match = /^(\d+(?:\.\d+)?)s$/.exec(String(detail.retryDelay ?? ''));
    if (match) candidates.push(capped(Number(match[1]) * 1000));
  }

  const usable = candidates.filter(value => value !== null);
  return usable.length ? Math.max(...usable) : null;
}

export const MODEL_REASONS = {
  notConfigured: 'not_configured',
  timeout: 'timeout',
  rateLimited: 'rate_limited',
  unauthorized: 'unauthorized',
  providerError: 'provider_error',
  malformedOutput: 'malformed_output',
  modelUnavailable: 'model_unavailable',
};
