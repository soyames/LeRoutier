import { useCallback, useEffect, useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, SectionTitle, ApiState } from '@leroutier/ui';
import { localTravelEstimateMinutes } from '@leroutier/geo';
import { MapPin, Clock, Car, Navigation, CheckCircle2, CircleDashed, Footprints } from 'lucide-react';

// First mile, journey timeline and last mile for one booking.
//
// LeRoutier does not book the local ride. The provider is presented as an
// external suggestion, and nothing here claims a fare, an ETA or a completed
// ride. The passenger's own position is used only on this device to sharpen a
// travel estimate: it is never sent to the API and never stored.
const time = value => (value ? new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null);
const day = value => (value ? new Date(value).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : null);

const LABELS = {
  booking_created: 'Réservation enregistrée',
  payment: 'Paiement',
  ticket_ready: 'Billet disponible',
  leave_for_boarding_point: 'Partir vers le point d’embarquement',
  boarding_opens: 'Début de l’embarquement',
  departure: 'Départ',
  arrival: 'Arrivée',
};

function StepIcon({ state }) {
  if (state === 'done') return <CheckCircle2 size={18}/>;
  if (state === 'advice') return <Footprints size={18}/>;
  return <CircleDashed size={18}/>;
}

export function JourneyTimeline({ bookingId }) {
  const { request, online } = useSession();
  const [travelMinutes, setTravelMinutes] = useState(null);
  const [locating, setLocating] = useState('');
  const path = bookingId ? `/journeys/${bookingId}/timeline${travelMinutes === null ? '' : `?localTravelMinutes=${travelMinutes}`}` : null;
  const journey = useApi(path);
  const data = journey.data;

  // Handoff funnel. Failure to record analytics must never block the journey.
  const track = useCallback(async (kind, leg = 'first_mile', providerId = undefined) => {
    try { await request('/mobility/handoff', { method: 'POST', body: { kind, leg, bookingId, ...(providerId ? { providerId } : {}) } }); }
    catch { /* measurement is best-effort; the passenger's journey continues */ }
  }, [request, bookingId]);

  useEffect(() => { if (data?.firstMile?.provider) track('suggestion_viewed', 'first_mile', data.firstMile.provider.id); }, [data?.firstMile?.provider, track]);

  // Ephemeral, on-device only: coordinates never leave the browser.
  function useMyPosition() {
    const point = data?.firstMile?.boardingPoint;
    if (!navigator.geolocation || !point || point.latitude === null) { setLocating('Position indisponible : utilisez le plan.'); return; }
    setLocating('Localisation…');
    navigator.geolocation.getCurrentPosition(
      position => {
        const minutes = localTravelEstimateMinutes({ latitude: position.coords.latitude, longitude: position.coords.longitude }, point);
        if (minutes === null) { setLocating('Position indisponible : utilisez le plan.'); return; }
        setTravelMinutes(minutes); setLocating('');
      },
      () => setLocating('Localisation refusée : l’heure ci-dessous reste une estimation standard.'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    );
  }

  if (!bookingId) return null;
  if (journey.loading || journey.error || !data) return <ApiState resource={journey} empty="Itinéraire indisponible."/>;
  const { firstMile, lastMile, plan, departurePoint, arrivalPoint } = data;

  return <div className="stack">
    <SectionTitle icon={Navigation} title="Votre trajet de bout en bout"/>

    {/* Exact boarding point first: it works with no provider, map or location. */}
    <Card className="stack">
      <SectionTitle icon={MapPin} title="Point d’embarquement exact"/>
      {departurePoint ? <>
        <strong>{departurePoint.name}</strong>
        <span className="small muted">{departurePoint.city}{departurePoint.landmark ? ` · ${departurePoint.landmark}` : ''}</span>
        {departurePoint.directionsUrl && <a className="small" href={departurePoint.directionsUrl} target="_blank" rel="noreferrer"
          onClick={() => track('directions_clicked')}>Voir le point d’embarquement sur le plan</a>}
      </> : <p className="small muted">Le point d’embarquement exact n’est pas encore publié par l’opérateur.</p>}
    </Card>

    <Card className="stack">
      <SectionTitle icon={Clock} title="Quand partir"/>
      <div className="between wrap">
        <div>
          <strong>Partez vers {time(plan.leaveBy)}</strong>
          <span className="small muted"> · {day(plan.departureAt)}</span>
        </div>
        <Badge tone="warning">Estimation</Badge>
      </div>
      <p className="small muted">
        Embarquement à partir de {time(plan.boardingOpensAt)}, départ à {time(plan.departureAt)}.
        Trajet local estimé à {plan.travelMinutes} min {plan.travelSource === 'client_estimate' ? '(d’après votre position)' : '(estimation standard)'},
        plus {plan.safetyBufferMinutes} min de marge. LeRoutier ne connaît pas le trafic en temps réel : traitez ces heures comme une estimation.
      </p>
      <div className="controls">
        <button className="btn btn-soft" onClick={useMyPosition} disabled={!online}>Affiner avec ma position</button>
        {travelMinutes !== null && <button className="btn btn-soft" onClick={() => setTravelMinutes(null)}>Estimation standard</button>}
      </div>
      {locating && <p className="small muted" role="status">{locating}</p>}
      <p className="small muted">Votre position reste sur votre appareil : elle n’est ni envoyée ni enregistrée.</p>
    </Card>

    {/* Optional assistance. Never a condition for boarding. */}
    <Card className="stack">
      <SectionTitle icon={Car} title="Rejoindre le point d’embarquement"/>
      {firstMile.provider ? <>
        <p>Besoin d’un transport jusqu’à votre point d’embarquement ?</p>
        <p className="small muted">
          Réservez avec {firstMile.provider.name} et arrivez à l’heure.
          {' '}{firstMile.provider.name} est un service indépendant : LeRoutier ne réserve pas la course,
          n’affiche ni tarif ni délai {firstMile.provider.name}, et ne confirme aucune course.
        </p>
        <div className="controls">
          <a className="btn btn-primary" href={firstMile.provider.launchUrl} target="_blank" rel="noreferrer"
            onClick={() => track('handoff_clicked', 'first_mile', firstMile.provider.id)}>Ouvrir {firstMile.provider.name}</a>
          {firstMile.directionsUrl && <a className="btn btn-soft" href={firstMile.directionsUrl} target="_blank" rel="noreferrer"
            onClick={() => track('directions_clicked')}>Itinéraire</a>}
          <button className="btn btn-soft" onClick={() => track('self_selected')}>J’y vais par mes propres moyens</button>
        </div>
        <Badge tone="neutral">Service externe : non intégré</Badge>
      </> : <>
        <p className="small muted">Aucun partenaire de transport local n’est proposé ici pour le moment.</p>
        {firstMile.directionsUrl && <a className="btn btn-soft" href={firstMile.directionsUrl} target="_blank" rel="noreferrer"
          onClick={() => track('directions_clicked')}>Voir l’itinéraire</a>}
      </>}
    </Card>

    <Card className="stack">
      <SectionTitle title="Étapes du voyage"/>
      {data.steps.map(step => <div key={step.key} className={`journey-step ${step.state}`}>
        <StepIcon state={step.state}/>
        <div>
          <strong className="small">{LABELS[step.key]}</strong>
          {step.key === 'arrival' && step.scheduled === false
            ? <span className="small muted"> · heure d’arrivée non programmée par l’opérateur</span>
            : step.at && <span className="small muted"> · {time(step.at)}</span>}
        </div>
        {step.estimated && <Badge tone="warning">estimation</Badge>}
        {step.state === 'cancelled' && <Badge tone="danger">annulé</Badge>}
      </div>)}
    </Card>

    {/* Last mile only becomes relevant once the passenger is actually moving. */}
    {lastMile.available && <Card className="stack">
      <SectionTitle icon={Car} title="À l’arrivée"/>
      {arrivalPoint && <span className="small muted">{arrivalPoint.name}{arrivalPoint.landmark ? ` · ${arrivalPoint.landmark}` : ''}</span>}
      <p>Besoin d’un transport jusqu’à votre destination finale ?</p>
      <div className="controls">
        {lastMile.provider && <a className="btn btn-primary" href={lastMile.provider.launchUrl} target="_blank" rel="noreferrer"
          onClick={() => track('handoff_clicked', 'last_mile', lastMile.provider.id)}>Ouvrir {lastMile.provider.name}</a>}
        {lastMile.directionsUrl && <a className="btn btn-soft" href={lastMile.directionsUrl} target="_blank" rel="noreferrer"
          onClick={() => track('directions_clicked', 'last_mile')}>Itinéraire</a>}
        <button className="btn btn-soft" onClick={() => track('self_selected', 'last_mile')}>J’y vais par mes propres moyens</button>
      </div>
    </Card>}
  </div>;
}
