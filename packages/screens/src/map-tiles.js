// Single source of truth for the basemap. Tile URLs live here and nowhere else,
// so swapping provider later is one file rather than every map component.
//
// Both styles are key-free open services with their attribution required and
// carried below. The OSM raster is the standard basemap; CARTO's free dark
// raster keeps a map readable inside a dark UI.
//
// Scale note: public OSM tile infrastructure is fine for a controlled pilot;
// moving to a hosted or self-run tile service is a change to TILE_STYLES alone.

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
// OpenStreetMap is the canonical basemap for LeRoutier. A hosted tile service
// can still be configured later, but the pilot must never silently fall back to
// a different map provider. Provider attribution is plain text configuration,
// never arbitrary HTML.
const configuredUrl = import.meta.env.VITE_MAP_TILE_URL;
const configuredAttribution = String(import.meta.env.VITE_MAP_TILE_ATTRIBUTION ?? '').replace(/[<>"&]/g, '');
const enabled = typeof configuredUrl === 'string' && configuredUrl.startsWith('https://') &&
  ['{z}','{x}','{y}'].every(part=>configuredUrl.includes(part)) && configuredAttribution.length>0;
const url = enabled ? configuredUrl : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

export const TILE_STYLES = {
  light: { url, attribution: `${OSM_ATTRIBUTION}${configuredAttribution ? ` ${configuredAttribution}` : ''}`, maxZoom: 19 },
  dark: { url, attribution: `${OSM_ATTRIBUTION}${configuredAttribution ? ` ${configuredAttribution}` : ''}`, maxZoom: 19 },
};

export const tileLayer = (dark = false) => (dark ? TILE_STYLES.dark : TILE_STYLES.light);

// Benin, so a transport map never opens on the whole world. These are the
// country's real bounding coordinates; panning beyond them stays possible
// because roads near a border need the neighbouring tiles.
export const BENIN_BOUNDS = [[6.14, 0.74], [12.45, 3.90]];
export const BENIN_CENTRE = [9.30, 2.32];
export const BENIN_DEFAULT_ZOOM = 7;
