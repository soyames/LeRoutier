import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip, useMap } from 'react-leaflet';
import { useSession } from '@leroutier/config/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { tileLayer, TILE_PROVIDER, BENIN_CENTRE, BENIN_DEFAULT_ZOOM } from './map-tiles.js';

// The transport map.
//
// Geography comes from the OpenStreetMap basemap itself — real roads, real
// towns, real borders — so no boundary polygon is bundled and every coordinate
// is genuine WGS84 lat/lon, the same space the GPS fixes arrive in.
//
// A route is drawn only from road geometry the routing engine produced. When
// there is none, the line is simply absent: stops are shown and the caller
// states that the road route is unavailable. A straight line between cities is
// never drawn as if it were a road.

const ROUTE_DONE = '#059669', ROUTE_AHEAD = '#94a3b8', VEHICLE = '#d97706';

// Leaflet's default marker images do not survive bundling; the vehicle uses a
// styled div so nothing depends on external image assets.
// The vehicle marker carries meaning, so it is announced — but it is not a
// command, and Leaflet's default keyboard handling would present it as one:
// a focusable role="button" with nothing to activate and no accessible name.
// It is an image with a label instead.
const escapeHtml = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const vehicleIconFor = label => L.divIcon({
  className: 'lr-vehicle-marker',
  html: `<span role="img" aria-label="${escapeHtml(label)}"></span>`,
  iconSize: [22, 22], iconAnchor: [11, 11],
});

// ── What LeRoutier knows about the ground ───────────────────────────────────
//
// A route line answers "where is the bus". It does not answer "where do I get
// on", which is the question somebody standing at a roadside actually has —
// and the answer is already in LeRoutier's own location registry: verified
// boarding points, company stations, public bus parks and stops, each with
// coordinates a person walked to and a moderator accepted.
//
// DRAWN UNDER THE ROUTE, ON PURPOSE. These markers are context, not content:
// they go in a Leaflet pane below the one the road line and the journey's own
// stops live in, so a boarding point can never sit on top of the stop somebody
// is trying to find. That is also why they are small, muted and labelled only
// on hover — a map of Benin covered in kerb labels obscures the journey it is
// meant to explain.
//
// THE ZOOM GATE IS THE DENSITY CONTROL. Below street level a city's boarding
// points collapse into an unreadable texture that hides the roads underneath
// it, so nothing is drawn until the map is close enough for a dot to mean a
// place. The traveller can also turn the layer off entirely.
const POI_MIN_ZOOM = 10;
const POI_PANE = 'lrPois';

/** How each kind of registered place is named to a passenger. */
const POI_KINDS = {
  company_station: 'Gare routière',
  public_bus_park: 'Gare routière publique',
  independent_boarding_point: 'Point d’embarquement',
  roadside_pickup: 'Arrêt de bord de route',
  parcel_consignment_point: 'Dépôt de colis',
  parcel_pickup_point: 'Retrait de colis',
};
const poiKind = key => POI_KINDS[key] ?? 'Point de la ligne';

/**
 * LeRoutier's published places, for the piece of map in view.
 *
 * Fetched per viewport rather than cached wholesale: "everything in the
 * country" is not a question a map asks, and the endpoint refuses to answer it.
 * The request follows the map — debounced, so dragging across Benin is one
 * query rather than thirty — and an in-flight answer for a viewport the reader
 * has already left is discarded rather than drawn in the wrong place.
 */
function PoiLayer({ enabled }) {
  const map = useMap();
  const { request, online } = useSession();
  // The answer is kept WITH the viewport it belongs to, rather than cleared
  // whenever the viewport moves: an empty list and "not asked yet" are the same
  // thing on screen, and clearing in an effect would be a second render for
  // every pan. Points that no longer match the viewport are simply not drawn.
  const [loaded, setLoaded] = useState({ key: '', points: [] });
  const [viewport, setViewport] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    if (typeof map.createPane === 'function' && !map.getPane(POI_PANE)) {
      const pane = map.createPane(POI_PANE);
      // Below the overlay pane (400), where the route line and the journey's
      // own stops are drawn.
      pane.style.zIndex = '350';
      pane.style.pointerEvents = 'auto';
    }
    const report = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const centre = map.getCenter(), bounds = map.getBounds();
        setViewport({ zoom: map.getZoom(), centre: [centre.lng, centre.lat],
          bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] });
      }, 350);
    };
    report();
    map.on('moveend', report);
    return () => { map.off('moveend', report); if (timer.current) clearTimeout(timer.current); };
  }, [map]);

  const visible = Boolean(enabled && viewport && viewport.zoom >= POI_MIN_ZOOM);
  const key = visible ? viewport.bbox.map(n => n.toFixed(5)).join(',') : '';
  const points = key && loaded.key === key ? loaded.points : [];

  useEffect(() => {
    if (!key || !online) return;
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      // A map that cannot load its points is still a map: the route, the stops
      // and the vehicle are drawn from data this call has nothing to do with,
      // and an error banner over them would be noise.
      const found = await request(`/map/points?bbox=${key}`, { signal: controller.signal }).catch(() => null);
      if (!cancelled) setLoaded({ key, points: Array.isArray(found) ? found : [] });
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [key, online, request]);

  return <>
    {points.map(point => <CircleMarker key={point.id} pane={POI_PANE}
      center={[point.latitude, point.longitude]} radius={4}
      pathOptions={{ color: '#fff', weight: 1, fillColor: point.kind === 'stop' ? '#94a3b8' : '#7c3aed', fillOpacity: 0.9 }}>
      <Tooltip direction="top">{poiKind(point.type)} · {point.name}{point.city ? ` (${point.city})` : ''}</Tooltip>
    </CircleMarker>)}
    {/* Everything drawn is also stated in words. The markers live on tiles a
        screen reader cannot read at all, and "there are boarding points near
        this stop" is the part of the map that answers a question. /tracking,
        which is where the reader is told what the layer is doing. */}
    <p className="sr-only" role="status">
      {!enabled ? 'Points utiles masqués.'
        : !visible ? 'Points utiles : zoomez pour afficher les points d’embarquement et les gares.'
          : points.length ? `${points.length} point${points.length > 1 ? 's' : ''} utile${points.length > 1 ? 's' : ''} affiché${points.length > 1 ? 's' : ''} sur la carte.`
            : 'Aucun point utile dans cette vue.'}
    </p>
  </>;
}

/** Keep the viewport on whatever matters: the route, else the vehicle. */
function Frame({ bounds, centre }) {
  const map = useMap();
  const applied = useRef('');
  useEffect(() => {
    const key = JSON.stringify(bounds ?? centre);
    if (!key || applied.current === key) return;
    applied.current = key;
    if (bounds) map.fitBounds(/** @type {[number, number][]} */ (bounds), { padding: [28, 28], maxZoom: 13 });
    else if (centre) map.setView(/** @type {[number, number]} */ (centre), 12);
  }, [map, bounds, centre]);
  return null;
}

/**
 * @param {{
 *  route?: [number, number][] | null,
 *  progressFraction?: number | null,
 *  vehicle?: { latitude: number, longitude: number } | null,
 *  vehicleLabel?: string,
 *  stops?: { sequence: number, name?: string, city?: string, latitude: number, longitude: number, state?: string }[],
 *  boardingSequence?: number | null, destinationSequence?: number | null,
 *  height?: number, dark?: boolean, ariaLabel?: string,
 *  pois?: boolean,
 * }} props
 */
export default function TransportMap({
  route = null, progressFraction = null, vehicle = null, vehicleLabel = 'Véhicule',
  stops = [], boardingSequence = null, destinationSequence = null,
  height = 320, dark = false, ariaLabel = 'Carte du trajet', pois = true,
}) {
  const tiles = tileLayer(dark);
  const [showPois, setShowPois] = useState(pois);
  // Leaflet takes [lat, lon]; route geometry is GeoJSON [lon, lat].
  const line = useMemo(() => /** @type {[number, number][]} */ (
    Array.isArray(route) ? route.map(([lon, lat]) => [lat, lon]) : []), [route]);

  // Split the line at the vehicle so travelled road reads differently from the
  // road ahead. Purely visual — the numbers come from the server.
  const split = useMemo(() => {
    if (line.length < 2 || progressFraction === null || !Number.isFinite(progressFraction)) return null;
    const index = Math.max(1, Math.min(line.length - 1, Math.round(progressFraction * (line.length - 1))));
    return { done: line.slice(0, index + 1), ahead: line.slice(index) };
  }, [line, progressFraction]);

  const bounds = line.length >= 2 ? line : null;
  const centre = vehicle ? [vehicle.latitude, vehicle.longitude] : null;

  return <div className="lr-map" style={{ height }} role="region" aria-label={ariaLabel} data-tile-provider={TILE_PROVIDER.id}>
    <MapContainer center={/** @type {[number, number]} */ (centre ?? BENIN_CENTRE)} zoom={centre ? 12 : BENIN_DEFAULT_ZOOM}
      scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
      {tiles.url && <TileLayer url={tiles.url} attribution={tiles.attribution} maxZoom={tiles.maxZoom}/>}
      <Frame bounds={bounds} centre={centre}/>
      <PoiLayer enabled={showPois}/>

      {split
        ? <>
          <Polyline positions={split.done} pathOptions={{ color: ROUTE_DONE, weight: 5, opacity: 0.9 }}/>
          <Polyline positions={split.ahead} pathOptions={{ color: ROUTE_AHEAD, weight: 5, opacity: 0.75 }}/>
        </>
        : line.length >= 2 && <Polyline positions={line} pathOptions={{ color: ROUTE_AHEAD, weight: 5, opacity: 0.8 }}/>}

      {stops.filter(s => Number.isFinite(s.latitude) && Number.isFinite(s.longitude)).map(stop => {
        const mine = stop.sequence === boardingSequence || stop.sequence === destinationSequence;
        return <CircleMarker key={stop.sequence} center={/** @type {[number, number]} */ ([stop.latitude, stop.longitude])}
          radius={mine ? 8 : 6}
          pathOptions={{ color: '#fff', weight: 2, fillColor: stop.state === 'passed' ? ROUTE_DONE : mine ? VEHICLE : '#0f172a', fillOpacity: 1 }}>
          <Tooltip direction="top">{stop.city ?? stop.name}{stop.sequence === boardingSequence ? ' · votre montée' : stop.sequence === destinationSequence ? ' · votre descente' : ''}</Tooltip>
        </CircleMarker>;
      })}

      {vehicle && Number.isFinite(vehicle.latitude) && <Marker keyboard={false}
        position={/** @type {[number, number]} */ ([vehicle.latitude, vehicle.longitude])} icon={vehicleIconFor(vehicleLabel)}>
        <Tooltip direction="top">{vehicleLabel}</Tooltip>
      </Marker>}
    </MapContainer>

    {/* The layer is a choice, not a fact about the map, so it is a real control
        with a pressed state — and its state is announced rather than implied by
        a colour. */}
    <button type="button" className="map-layer-toggle" aria-pressed={showPois} onClick={() => setShowPois(v => !v)}>
      {showPois ? 'Masquer les points utiles' : 'Afficher les points utiles'}
    </button>

  </div>;
}

// ---------------------------------------------------------------------------
// The journey-plan map: a complete door-to-destination offer on one map.
//
//   requested origin ──· · · · ──▶ pickup stop ───▶ intercity (road geometry)
//   ───▶ drop-off stop ──· · · · ──▶ requested destination
//
// First and last mile are walking estimates (dashed, labelled); the intercity
// line is real road geometry from the routing engine — a straight line is
// never drawn as if it were a road. A vehicle position appears only when GPS
// data exists, labelled live or "last known" exactly as the API reports it.

const MILE_DONE = '#059669', MILE_AHEAD = '#d97706', INTERCITY = '#0f172a', ORIGIN = '#d97706', DESTINATION = '#059669';

/** A passenger's requested origin/destination (place or current position). */
const pin = label => L.divIcon({ className: 'lr-vehicle-marker', html: `<span role="img" aria-label="${escapeHtml(label)}"></span>`,
  iconSize: [22, 22], iconAnchor: [11, 11] });

/**
 * @param {{
 *  option: any,
 *  originPoint?: { latitude: number, longitude: number, label?: string } | null,
 *  destinationPoint?: { latitude: number, longitude: number, label?: string } | null,
 *  height?: number, ariaLabel?: string,
 * }} props
 */
export function JourneyPlanMap({ option = null, originPoint = null, destinationPoint = null, height = 380, ariaLabel = 'Carte du trajet complet' }) {
  const tiles = tileLayer(false);
  const miles = [];
  let intercity = [];
  const markers = [];
  if (option?.firstMile && originPoint && option.pickupStop && Number.isFinite(option.pickupStop.latitude)) {
    miles.push({ key: 'first', points: [[originPoint.latitude, originPoint.longitude], [option.pickupStop.latitude, option.pickupStop.longitude]] });
  }
  if (option?.lastMile && destinationPoint && option.dropoffStop && Number.isFinite(option.dropoffStop.latitude)) {
    miles.push({ key: 'last', points: [[option.dropoffStop.latitude, option.dropoffStop.longitude], [destinationPoint.latitude, destinationPoint.longitude]] });
  }
  if (Array.isArray(option?.routeGeometry) && option.routeGeometry.length >= 2) {
    intercity = option.routeGeometry.map(([lon, lat]) => [lat, lon]);
  }
  for (const stop of (option?.intermediateStops ?? [])) {
    if (Number.isFinite(stop.latitude)) markers.push({ ...stop, kind: 'stop' });
  }
  if (option?.pickupStop && Number.isFinite(option.pickupStop.latitude)) markers.push({ ...option.pickupStop, kind: 'pickup', latitude: option.pickupStop.latitude });
  if (option?.dropoffStop && Number.isFinite(option.dropoffStop.latitude)) markers.push({ ...option.dropoffStop, kind: 'dropoff', latitude: option.dropoffStop.latitude });
  if (option?.livePosition && Number.isFinite(option.livePosition.latitude)) markers.push({ ...option.livePosition, kind: 'vehicle' });

  const all = [...intercity, ...miles.flatMap(m => m.points), ...markers.map(m => [m.latitude, m.longitude])];
  const bounds = all.length >= 2 ? /** @type {[number, number][]} */ (all) : null;
  const centre = option?.livePosition ? /** @type {[number, number]} */ ([option.livePosition.latitude, option.livePosition.longitude]) : null;

  return <div className="lr-map" style={{ height }} role="region" aria-label={ariaLabel}>
    <MapContainer center={/** @type {[number, number]} */ (centre ?? BENIN_CENTRE)} zoom={centre ? 11 : BENIN_DEFAULT_ZOOM}
      scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
      {tiles.url && <TileLayer url={tiles.url} attribution={tiles.attribution} maxZoom={tiles.maxZoom}/>}
      <Frame bounds={bounds} centre={centre}/>

      {miles.map(m => <Polyline key={m.key} positions={m.points} dashArray="6 8"
        pathOptions={{ color: m.key === 'first' ? MILE_DONE : MILE_AHEAD, weight: 3, opacity: 0.9 }}/>)}
      {intercity.length >= 2 && <Polyline positions={intercity} pathOptions={{ color: INTERCITY, weight: 5, opacity: 0.85 }}/>}

      {originPoint && Number.isFinite(originPoint.latitude) &&
        <Marker keyboard={false} position={[originPoint.latitude, originPoint.longitude]} icon={pin(originPoint.label ?? 'Départ')}>
          <Tooltip direction="top">{originPoint.label ?? 'Départ'}</Tooltip></Marker>}
      {destinationPoint && Number.isFinite(destinationPoint.latitude) &&
        <Marker keyboard={false} position={[destinationPoint.latitude, destinationPoint.longitude]} icon={pin(destinationPoint.label ?? 'Destination')}>
          <Tooltip direction="top">{destinationPoint.label ?? 'Destination'}</Tooltip></Marker>}

      {markers.map((m, i) => <CircleMarker key={m.kind + '-' + i} center={[m.latitude, m.longitude]}
        radius={m.kind === 'vehicle' ? 8 : m.kind === 'pickup' || m.kind === 'dropoff' ? 7 : 5}
        pathOptions={{ color: '#fff', weight: 2,
          fillColor: m.kind === 'vehicle' ? ORIGIN : m.kind === 'pickup' ? '#0f172a' : m.kind === 'dropoff' ? DESTINATION : '#64748b', fillOpacity: 1 }}>
        <Tooltip direction="top">
          {option.isTest && <strong>TEST ? </strong>}
          {m.kind === 'vehicle'
            ? (m.signal === 'live' ? 'En direct' : 'Dernière position connue')
            : m.kind === 'pickup' ? `Montée · ${m.name ?? m.city}` : m.kind === 'dropoff' ? `Descente · ${m.name ?? m.city}` : (m.city ?? m.name)}
        </Tooltip>
      </CircleMarker>)}
    </MapContainer>
  </div>;
}
