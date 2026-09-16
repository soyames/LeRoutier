// Road routing, provider-neutral.
//
// LeRoutier is not coupled to one routing engine. An adapter takes ordered stop
// coordinates and returns road geometry; the domain stores and measures it.
//
// The shipped driver speaks the OSRM HTTP API, which is what OSRM itself, a
// self-hosted instance and several OSRM-compatible services all expose. It is
// configured by URL, so moving to a self-hosted engine is an environment change.
//
// **Unconfigured means unavailable, never a straight line.** The public OSRM
// and Valhalla demo servers forbid production use, so no default endpoint is
// baked in: an operator points LeRoutier at an engine they are entitled to use.
// Until then routes simply have no road geometry and every surface says so.

export class RoutingUnavailable extends Error {
  constructor(reason, detail = '') { super(detail || reason); this.name = 'RoutingUnavailable'; this.reason = reason; }
}

/** Reasons Ops can act on, kept separate from any provider wording. */
export const ROUTING_REASONS = {
  NOT_CONFIGURED: 'not_configured',
  MISSING_COORDINATES: 'missing_coordinates',
  NO_ROUTE: 'no_route',
  PROVIDER_ERROR: 'provider_error',
  PROVIDER_TIMEOUT: 'provider_timeout',
  MALFORMED_GEOMETRY: 'malformed_geometry',
};

const isCoordinate = stop => Number.isFinite(stop?.longitude) && Number.isFinite(stop?.latitude) &&
  stop.longitude >= -180 && stop.longitude <= 180 && stop.latitude >= -90 && stop.latitude <= 90;

/**
 * Build a routing adapter from server configuration.
 * @param {{routing?: {url?: string, provider?: string, timeoutMs?: number, apiKey?: string}}} config
 * @param {typeof fetch} [fetchImpl] injected in tests so no suite depends on a provider being online
 */
export function createRouter(config = {}, fetchImpl = globalThis.fetch) {
  const { url, provider = 'osrm', timeoutMs = 15_000, apiKey } = config.routing ?? {};
  const configured = typeof url === 'string' && /^https?:\/\//.test(url);

  return {
    provider,
    configured,

    /**
     * Road geometry through the given stops, in order.
     * @param {{longitude:number,latitude:number}[]} stops
     * @returns {Promise<{coordinates:[number,number][], distanceM:number, provider:string}>}
     */
    async route(stops) {
      if (!configured) throw new RoutingUnavailable(ROUTING_REASONS.NOT_CONFIGURED, 'No routing engine is configured.');
      if (!Array.isArray(stops) || stops.length < 2) {
        throw new RoutingUnavailable(ROUTING_REASONS.MISSING_COORDINATES, 'At least two stops are required.');
      }
      if (!stops.every(isCoordinate)) {
        throw new RoutingUnavailable(ROUTING_REASONS.MISSING_COORDINATES, 'Every stop needs valid coordinates.');
      }

      // OSRM: /route/v1/driving/{lon,lat};{lon,lat}?overview=full&geometries=geojson
      const path = stops.map(s => `${s.longitude},${s.latitude}`).join(';');
      const endpoint = `${url.replace(/\/$/, '')}/route/v1/driving/${path}?overview=full&geometries=geojson&continue_straight=false`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          signal: controller.signal,
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        });
      } catch (error) {
        throw new RoutingUnavailable(
          error?.name === 'AbortError' ? ROUTING_REASONS.PROVIDER_TIMEOUT : ROUTING_REASONS.PROVIDER_ERROR,
          'The routing engine did not respond.');
      } finally { clearTimeout(timer); }

      if (!response.ok) {
        // The provider's status is enough for Ops; its body is not shown.
        throw new RoutingUnavailable(ROUTING_REASONS.PROVIDER_ERROR, `Routing engine returned ${response.status}.`);
      }
      let payload;
      try { payload = await response.json(); } catch { throw new RoutingUnavailable(ROUTING_REASONS.MALFORMED_GEOMETRY, 'Routing response was not readable.'); }

      const leg = payload?.routes?.[0];
      if (payload?.code && payload.code !== 'Ok') {
        throw new RoutingUnavailable(ROUTING_REASONS.NO_ROUTE, 'No road route connects these stops.');
      }
      const coordinates = leg?.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        throw new RoutingUnavailable(ROUTING_REASONS.NO_ROUTE, 'No road route connects these stops.');
      }
      if (!coordinates.every(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))) {
        throw new RoutingUnavailable(ROUTING_REASONS.MALFORMED_GEOMETRY, 'Routing geometry was malformed.');
      }
      const distanceM = Math.round(Number(leg.distance));
      if (!Number.isFinite(distanceM) || distanceM <= 0) {
        throw new RoutingUnavailable(ROUTING_REASONS.MALFORMED_GEOMETRY, 'Routing distance was missing.');
      }
      return { coordinates, distanceM, provider };
    },
  };
}
