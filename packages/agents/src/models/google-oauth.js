// A Google OAuth access token, minted on demand from a refresh credential.
//
// LeRoutier reaches the Gemini Developer API with an OAuth bearer token, not an
// API key. That choice is deliberate: an API key is a bearer secret with no
// expiry that has to exist somewhere forever, while a refresh credential mints
// tokens that die in an hour and can be revoked from the Google account that
// granted them.
//
// Nothing here is ever logged, persisted or returned to a caller. The access
// token exists in memory, for at most its lifetime, inside one serverless
// instance — it is never written to Neon and never reaches the browser.

import { ModelUnavailable, MODEL_REASONS } from './errors.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Refreshing exactly at expiry races the clock: the token can die between the
 * check and the request arriving at Google. Sixty seconds is the usual margin
 * for clock skew plus flight time.
 */
const DEFAULT_SKEW_SECONDS = 60;

/**
 * A token endpoint that hangs must not consume the model call's whole budget.
 * This is a separate, shorter deadline than the completion's.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @param {{ clientId?: string, clientSecret?: string, refreshToken?: string,
 *   tokenUrl?: string, skewSeconds?: number, timeoutMs?: number }} config
 * @param {typeof fetch} [fetchImpl]
 * @param {() => number} [now] injectable clock, so expiry is testable without waiting
 */
export function createGoogleTokenSource(config = {}, fetchImpl = fetch, now = Date.now) {
  const { clientId, clientSecret, refreshToken } = config;
  const tokenUrl = config.tokenUrl || GOOGLE_TOKEN_URL;
  const skewMs = (Number(config.skewSeconds) > 0 ? Number(config.skewSeconds) : DEFAULT_SKEW_SECONDS) * 1000;
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  // All three or none. Two out of three is a misconfiguration, and treating it
  // as "configured" would turn every call into an authorization failure.
  const configured = Boolean(clientId && clientSecret && refreshToken);

  /** @type {{ token: string, expiresAt: number } | null} */
  let cached = null;
  /** @type {Promise<string> | null} */
  let inFlight = null;

  async function mint() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: /** @type {string} */ (refreshToken),
          client_id: /** @type {string} */ (clientId),
          client_secret: /** @type {string} */ (clientSecret),
        }).toString(),
        signal: controller.signal,
      });
    } catch (error) {
      // The error is not propagated: a fetch failure can carry the request URL
      // and, in some runtimes, the body that was being sent.
      throw new ModelUnavailable(error?.name === 'AbortError' ? MODEL_REASONS.timeout : MODEL_REASONS.providerError,
        'the Google token endpoint could not be reached');
    } finally { clearTimeout(timer); }

    let payload = null;
    try { payload = await response.json(); } catch { /* handled as a shape failure below */ }

    if (!response.ok) {
      // A revoked or expired refresh credential arrives as 400 invalid_grant.
      // That is an authorization problem to be fixed by a human, not something
      // to retry — and the description is not echoed, because Google includes
      // the client id in some of them.
      const unauthorized = [400, 401, 403].includes(response.status);
      throw new ModelUnavailable(unauthorized ? MODEL_REASONS.unauthorized : MODEL_REASONS.providerError,
        `the Google token endpoint responded ${response.status}`);
    }
    if (!payload || typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new ModelUnavailable(MODEL_REASONS.malformedOutput, 'the Google token endpoint returned no access token');
    }

    // Google always sends expires_in; an absent or absurd value is treated as a
    // short life rather than an unlimited one.
    const lifetimeMs = Number(payload.expires_in) > 0 ? Number(payload.expires_in) * 1000 : 5 * 60_000;
    cached = { token: payload.access_token, expiresAt: now() + Math.max(lifetimeMs - skewMs, 0) };
    return cached.token;
  }

  return {
    configured,

    /**
     * A valid access token, minted only when the cached one is gone or nearly.
     *
     * Concurrent callers share one refresh. On Vercel a cold instance serving
     * several events at once would otherwise send several identical refresh
     * requests, and Google rate-limits the token endpoint per client.
     */
    async token() {
      if (!configured) throw new ModelUnavailable(MODEL_REASONS.notConfigured, 'no Google OAuth credential is configured');
      if (cached && now() < cached.expiresAt) return cached.token;
      // A failed mint clears the shared promise, so the next caller retries
      // rather than inheriting a rejection forever. Failure is closed: no token
      // means no call, never an unauthenticated one.
      if (!inFlight) inFlight = mint().finally(() => { inFlight = null; });
      return inFlight;
    },

    /**
     * Drops the cached token. Called when Google refuses a token it previously
     * issued — revocation, or a rotation on their side — so the next attempt
     * mints a fresh one instead of replaying a dead one until it expires.
     */
    forget() { cached = null; },

    /** Test/observability seam. Never exposes the token itself. */
    get state() { return { hasToken: Boolean(cached), expiresAt: cached?.expiresAt ?? null, refreshing: Boolean(inFlight) }; },
  };
}
