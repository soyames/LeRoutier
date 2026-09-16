// Single source of truth for the basemap. Tile URLs live here and nowhere else,
// so swapping provider later is one file rather than every map component.
//
// Both styles are key-free open services with their attribution required and
// carried below. The OSM raster is the standard basemap; CARTO's free dark
// raster keeps a map readable inside a dark UI.
//
// Scale note: public OSM tile infrastructure is fine for a controlled pilot but
// must not be leaned on at production volume. See
// docs/architecture/MAPS_ROUTING_AND_TRACKING.md — moving to a hosted or
// self-run tile service is a change to TILE_STYLES alone.

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CARTO_ATTRIBUTION = `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions">CARTO</a>`;

export const TILE_STYLES = {
  light: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_ATTRIBUTION, maxZoom: 19 },
  dark: { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', attribution: CARTO_ATTRIBUTION, maxZoom: 20 },
};

export const tileLayer = (dark = false) => (dark ? TILE_STYLES.dark : TILE_STYLES.light);

// Benin, so a transport map never opens on the whole world. These are the
// country's real bounding coordinates; panning beyond them stays possible
// because roads near a border need the neighbouring tiles.
export const BENIN_BOUNDS = [[6.14, 0.74], [12.45, 3.90]];
export const BENIN_CENTRE = [9.30, 2.32];
export const BENIN_DEFAULT_ZOOM = 7;
