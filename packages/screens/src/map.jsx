import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { tileLayer, BENIN_CENTRE, BENIN_DEFAULT_ZOOM } from './map-tiles.js';

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
 * }} props
 */
export default function TransportMap({
  route = null, progressFraction = null, vehicle = null, vehicleLabel = 'Véhicule',
  stops = [], boardingSequence = null, destinationSequence = null,
  height = 320, dark = false, ariaLabel = 'Carte du trajet',
}) {
  const tiles = tileLayer(dark);
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

  return <div className="lr-map" style={{ height }} role="region" aria-label={ariaLabel}>
    <MapContainer center={/** @type {[number, number]} */ (centre ?? BENIN_CENTRE)} zoom={centre ? 12 : BENIN_DEFAULT_ZOOM}
      scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
      {tiles.url && <TileLayer url={tiles.url} attribution={tiles.attribution} maxZoom={tiles.maxZoom}/>}
      <Frame bounds={bounds} centre={centre}/>

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
