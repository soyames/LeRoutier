import { Suspense, lazy, useEffect, useState } from 'react';
import { useSession } from '@leroutier/config/client';
import { Card, Badge, SectionTitle, ErrorState, SkeletonCards } from '@leroutier/ui';
import { MapPin, Navigation, CircleDashed, CheckCircle2, Bus } from 'lucide-react';

// Live vehicle tracking for one journey.
//
// Leaflet and the map component are loaded only when a map is actually shown,
// so the map never costs anything on screens without one.
const TransportMap = lazy(() => import('./map.jsx'));

// How the last GPS fix is described. "Live" is used only when LeRoutier is
// genuinely receiving recent positions; anything older says so plainly.
const SIGNAL = {
  live: { label: 'Suivi en direct', tone: 'success' },
  delayed: { label: 'Signal GPS retardé', tone: 'warning' },
  stale: { label: 'Dernière position connue', tone: 'warning' },
  unavailable: { label: 'Suivi indisponible', tone: 'neutral' },
};

const STOP_STATE = {
  passed: { label: 'Passé', icon: CheckCircle2, tone: 'done' },
  arriving: { label: 'Arrivée en cours', icon: Bus, tone: 'active' },
  next: { label: 'Prochain arrêt', icon: Bus, tone: 'active' },
  upcoming: { label: '', icon: CircleDashed, tone: '' },
};

function age(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `il y a ${minutes} min` : `il y a ${Math.round(minutes / 60)} h`;
}
const clock = value => (value ? new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null);
const km = metres => (Number.isFinite(metres) ? `${Math.round(metres / 1000)} km` : null);

/** How an arrival estimate is worded, by how much it can be trusted. */
function arrivalLine(eta) {
  if (!eta?.at) return 'Heure d’arrivée indisponible pour le moment.';
  const time = clock(eta.at);
  if (eta.confidence === 'live') return `Arrivée estimée vers ${time}`;
  if (eta.confidence === 'estimated') return `Arrivée estimée vers ${time} (estimation)`;
  return `Arrivée prévue à l’horaire : ${time}`;
}

/**
 * @param {{ bookingId: string, pollMs?: number }} props
 * Polling, not sockets: the API runs as serverless functions on Vercel, where a
 * long-lived connection per passenger has no natural home. A short interval
 * while the screen is open is sufficient for a bus and costs far less. The
 * transport is isolated here, so a streaming upgrade later touches this file.
 */
export function JourneyTracking({ bookingId, pollMs = 20_000 }) {
  const { request } = useSession();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!bookingId) return;
    let cancelled = false, timer = null;
    async function load() {
      try {
        const result = await request(`/journeys/${bookingId}/tracking`);
        if (!cancelled) { setData(result); setError(''); }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) { setLoading(false); timer = setTimeout(load, pollMs); }
      }
    }
    load();
    // Stop polling when the tab is hidden: a backgrounded phone should not keep
    // requesting positions nobody is looking at.
    const onVisibility = () => { if (document.visibilityState === 'visible' && !timer) load(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { cancelled = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [bookingId, request, pollMs]);

  if (!bookingId) return null;
  if (loading) return <SkeletonCards count={1} lines={5}/>;
  if (error) return <ErrorState title="Suivi indisponible" text={error}/>;
  if (!data) return null;

  const signal = SIGNAL[data.signal] ?? SIGNAL.unavailable;
  const hasRoad = data.route?.available === true;
  const mapStops = (data.stops ?? []).map(stop => ({ ...stop }));

  return <div className="stack">
    <SectionTitle icon={Navigation} title="Où est mon véhicule"/>

    <Card className="stack">
      <div className="between wrap">
        <Badge tone={signal.tone}><Bus size={13}/>{signal.label}</Badge>
        {/* The age of the last fix, always, so nothing looks fresher than it is. */}
        {data.signalAgeSeconds !== null && <span className="small muted">Position mise à jour {age(data.signalAgeSeconds)}</span>}
      </div>

      {data.position && hasRoad
        ? <Suspense fallback={<SkeletonCards count={1} lines={4}/>}>
          <TransportMap route={data.route.coordinates} progressFraction={data.progress?.fraction ?? null}
            vehicle={data.position} vehicleLabel={signal.label} stops={mapStops}
            boardingSequence={data.boardingSequence} destinationSequence={data.destinationSequence}
            ariaLabel="Carte du véhicule sur son itinéraire"/>
        </Suspense>
        : <p className="small muted" role="status">
          {!hasRoad
            ? 'L’itinéraire routier de cette ligne n’est pas encore disponible. Les arrêts ci-dessous restent exacts.'
            : 'Le véhicule n’a pas encore partagé sa position. Le suivi démarre généralement peu avant le départ.'}
        </p>}

      {/* Everything on the map is also stated in words. */}
      <div className="summary">
        {data.nextStop && <div className="row"><span>Prochain arrêt</span><span>{data.nextStop.city}</span></div>}
        {data.progress && <>
          <div className="row"><span>Distance parcourue</span><span>{km(data.progress.distanceAlongM)}</span></div>
          <div className="row"><span>Distance restante</span><span>{km(data.progress.remainingM)}</span></div>
        </>}
        <div className="row"><span>Arrivée</span><span>{arrivalLine(data.eta)}</span></div>
      </div>
      {data.eta?.confidence === 'scheduled' && <p className="small muted">
        Sans signal GPS récent, cette heure vient de l’horaire de l’opérateur, pas de la position du véhicule.</p>}
    </Card>

    <Card className="stack">
      <SectionTitle icon={MapPin} title="Progression du trajet"/>
      {(data.stops ?? []).map(stop => {
        const state = STOP_STATE[stop.state] ?? STOP_STATE.upcoming;
        const Icon = state.icon;
        const mine = stop.sequence === data.boardingSequence || stop.sequence === data.destinationSequence;
        return <div key={stop.sequence} className={`journey-step ${state.tone}`}>
          <Icon size={17}/>
          <div>
            <strong className="small">{stop.city}</strong>
            {mine && <span className="small muted"> · {stop.sequence === data.boardingSequence ? 'votre montée' : 'votre descente'}</span>}
          </div>
          {state.label && <Badge tone={stop.state === 'passed' ? 'success' : 'warning'}>{state.label}</Badge>}
        </div>;
      })}
    </Card>
  </div>;
}
