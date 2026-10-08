// Single source of truth for the basemap. Tile URLs live here and nowhere else,
// so swapping provider later is one file rather than every map component.
//
// TWO SERVICES, CONFIGURED SEPARATELY. The basemap — the roads, towns and
// borders a map is drawn on — is a tile service. The road line drawn on top of
// it comes from the routing engine on the server (`@leroutier/routing`,
// ROUTING_URL). They have different providers, different terms and different
// credentials, and neither one substitutes for the other: this file is only
// ever about the tiles.
//
// THE PILOT FALLBACK IS NAMED, NOT SILENT. OpenStreetMap's own tile servers are
// a shared, donated resource whose tile usage policy is written for
// OpenStreetMap's own needs — mapping, editing, and small sites — not for a
// commercial product's traffic. They are what this map draws on until a
// provider is configured, and that is a deliberate, temporary state rather
// than a default nobody noticed: `TILE_PROVIDER.configured` is false, the
// provider has a name, and Platform Ops is told which one is in use.
//
// WHAT TO SET FOR PRODUCTION, on the le-routier project (build-time values, so
// a change needs a redeploy):
//
//   VITE_MAP_TILE_URL            https://…/{z}/{x}/{y}.png   (or .jpg / vector raster)
//   VITE_MAP_TILE_URL_DARK       optional; falls back to the light one
//   VITE_MAP_TILE_ATTRIBUTION    the provider's required credit line, plain text
//   VITE_MAP_TILE_MAX_ZOOM       optional; the provider's own ceiling
//
// A tile key belongs in the URL only where the provider's terms say a
// browser-readable key is expected (that is how raster tile keys work, and
// they are restricted by referrer). A ROUTING key is never here: it is a
// server-side secret and belongs in ROUTING_API_KEY on the API project.

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const OSM_PUBLIC_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

const read = (env, name) => {
  const value = env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
};
// Provider attribution is plain text configuration, never arbitrary HTML.
const sanitize = value => String(value ?? '').replace(/[<>"&]/g, '');
const isTemplate = url => url.startsWith('https://') && ['{z}', '{x}', '{y}'].every(part => url.includes(part));

/**
 * What the tiles are, given an environment.
 *
 * A pure function of the variables rather than a module-level read, because the
 * interesting cases are the MISCONFIGURATIONS — a URL with no attribution to
 * carry, a template missing a placeholder, a max zoom that is not a number —
 * and none of them can be produced by editing a file at test time.
 *
 * A configured URL is only usable WITH an attribution: a tile service whose
 * credit line has been left blank is one this product is not entitled to draw
 * from, so that misconfiguration falls back rather than shipping uncredited
 * tiles.
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveTiles(env = {}) {
  const configuredUrl = read(env, 'VITE_MAP_TILE_URL');
  const configuredDarkUrl = read(env, 'VITE_MAP_TILE_URL_DARK');
  const configuredAttribution = sanitize(read(env, 'VITE_MAP_TILE_ATTRIBUTION'));
  const configuredMaxZoom = Number(read(env, 'VITE_MAP_TILE_MAX_ZOOM'));

  const usable = isTemplate(configuredUrl) && configuredAttribution.length > 0;
  const attribution = `${OSM_ATTRIBUTION}${usable ? ` ${configuredAttribution}` : ''}`;
  const maxZoom = Number.isFinite(configuredMaxZoom) && configuredMaxZoom >= 1 && configuredMaxZoom <= 24
    ? configuredMaxZoom : 19;
  const light = usable ? configuredUrl : OSM_PUBLIC_URL;

  return {
    styles: {
      light: { url: light, attribution, maxZoom },
      dark: { url: usable && isTemplate(configuredDarkUrl) ? configuredDarkUrl : light, attribution, maxZoom },
    },
    /**
     * Which basemap is actually being drawn, for the people who can act on it.
     *
     * `configured: false` means this deployment is on OpenStreetMap's shared
     * public tiles — fine for a pilot, not fine for production traffic, and
     * never something to discover from a support ticket. The id NAMES the
     * fallback so a console, a test or an operator reads which one is in use
     * instead of inferring it from a URL.
     */
    provider: { id: usable ? 'configured' : 'osm-public', configured: usable, attribution, maxZoom },
  };
}

const resolved = resolveTiles(import.meta.env ?? {});
export const TILE_STYLES = resolved.styles;
export const TILE_PROVIDER = resolved.provider;

// Benin, so a transport map never opens on the whole world. These are the
// country's real bounding coordinates; panning beyond them stays possible
// because roads near a border need the neighbouring tiles.
export const BENIN_BOUNDS = [[6.14, 0.74], [12.45, 3.90]];
export const BENIN_CENTRE = [9.30, 2.32];
export const BENIN_DEFAULT_ZOOM = 7;

export const tileLayer = (dark = false) => (dark ? TILE_STYLES.dark : TILE_STYLES.light);
