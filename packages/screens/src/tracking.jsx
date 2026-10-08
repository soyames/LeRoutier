import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '@leroutier/config/client';
import { Card, Badge, SectionTitle, ErrorState, SkeletonCards } from '@leroutier/ui';
import { MapPin, Navigation, CircleDashed, CheckCircle2, Bus, Ticket, Search, Lock } from 'lucide-react';

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
 * Where a journey stands, in words, before any GPS is involved.
 *
 * The stop list and the arrival estimate below can both be complete and still
 * describe a journey that is over or will not happen. Saying so first is what
 * stops a finished trip reading as one in progress.
 */
function journeyState(ticket) {
  if (ticket.status === 'cancelled' || ticket.serviceStatus === 'cancelled')
    return { key: 'cancelled', tone: 'danger', label: 'Service annulé',
      text: 'Ce départ a été annulé. Le suivi n’est plus disponible pour ce billet. Contactez l’opérateur ou LeRoutier pour la suite.' };
  if (ticket.status === 'completed' || ticket.serviceStatus === 'completed')
    return { key: 'completed', tone: 'neutral', label: 'Voyage terminé',
      text: 'Ce voyage est arrivé à son terme. Le suivi s’arrête ici ; votre billet reste consultable.' };
  if (ticket.status === 'boarded') return { key: 'boarded', tone: 'success', label: 'À bord', text: null };
  if (ticket.serviceStatus === 'disrupted')
    return { key: 'disrupted', tone: 'warning', label: 'Service perturbé',
      text: 'L’opérateur signale une perturbation sur ce départ. Les informations ci-dessous peuvent changer sans préavis.' };
  return { key: 'confirmed', tone: 'success', label: 'Billet confirmé', text: null };
}

/**
 * Everything a tracked journey looks like, with no idea where the data came
 * from.
 *
 * ONE presentation for both readers — a signed-in passenger's own booking and
 * a visitor holding only a ticket number — because they are the same
 * question ("where is my bus") and must never drift into two answers. The
 * payloads differ only in how they were authorized, not in what they say.
 *
 * @param {{ data: any, title?: string, arrivalLabel?: string, children?: any }} props
 */
export function TrackingPanel({ data, title = 'Où est mon véhicule', arrivalLabel = 'Votre arrivée', children = null }) {
  const signal = SIGNAL[data.signal] ?? SIGNAL.unavailable;
  const hasRoad = data.route?.available === true;
  const mapStops = (data.stops ?? []).map(stop => ({ ...stop }));

  return <div className="stack">
    <SectionTitle icon={Navigation} title={title}/>

    <Card className="stack">
      <div className="between wrap">
        <Badge tone={signal.tone}><Bus size={13}/>{signal.label}</Badge>
        {/* The age of the last fix, always, so nothing looks fresher than it is. */}
        {data.signalAgeSeconds !== null && data.signalAgeSeconds !== undefined &&
          <span className="small muted">Position mise à jour {age(data.signalAgeSeconds)}</span>}
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
        {data.progress && <>
          <div className="row"><span>Distance parcourue</span><span>{km(data.progress.distanceAlongM)}</span></div>
          <div className="row"><span>Distance restante</span><span>{km(data.progress.remainingM)}</span></div>
        </>}
        {data.nextStop && <div className="row"><span>Prochain arrêt</span><span>{data.nextStop.city}{data.nextEta?.at ? ` · ${clock(data.nextEta.at)}` : ''}</span></div>}
        {/* Whose arrival this is depends on who is reading. A traveller is
            told about their own stop; the crew tracking a whole service are
            told about the end of the line, which is a different time. */}
        <div className="row"><span>{arrivalLabel}</span><span>{arrivalLine(data.eta)}</span></div>
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

    {children}
  </div>;
}

/**
 * A journey read as its owner.
 *
 * @param {{ bookingId?: string|null, serviceId?: string|null, pollMs?: number, token?: string|null }} props
 * `token` names the identity the journey is read as, for a purchase made without
 * an account: an explicit null reads as a visitor.
 *
 * Polling, not sockets: the API runs as serverless functions on Vercel, where a
 * long-lived connection per passenger has no natural home. A short interval
 * while the screen is open is sufficient for a bus and costs far less. The
 * transport is isolated here, so a streaming upgrade later touches this file.
 */
export function JourneyTracking({ bookingId, serviceId, pollMs = 20_000, token }) {
  const { request } = useSession();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!bookingId && !serviceId) return;
    let cancelled = false, timer = null;
    async function load() {
      try {
        const result = await request(bookingId
          ? `/journeys/${bookingId}/tracking`
          : `/services/${serviceId}/tracking`, token === undefined ? {} : { token });
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
  }, [bookingId, serviceId, request, pollMs, token]);

  if (!bookingId && !serviceId) return null;
  if (loading) return <SkeletonCards count={1} lines={5}/>;
  if (error) return <ErrorState title="Suivi indisponible" text={error}/>;
  if (!data) return null;

  return <TrackingPanel data={data}
    title={serviceId ? 'Progression du service' : 'Où est mon véhicule'}
    arrivalLabel={serviceId ? 'Arrivée prévue' : 'Votre arrivée'}/>;
}

// The crew sees the same route truth as passengers, but the service endpoint
// authorizes it by assignment and does not expose a passenger's destination.
export function ServiceTracking({ serviceId, pollMs = 20_000 }) {
  return <JourneyTracking serviceId={serviceId} pollMs={pollMs}/>;
}

// ── A ticket number, and nothing else ──────────────────────────────────────

// What each refusal means to somebody who typed a number into a box. The
// three are genuinely different problems and only one of them is the
// traveller's to fix, so they are never collapsed into "ça n'a pas marché".
const LOOKUP_ERRORS = {
  INVALID_REFERENCE: 'Ce numéro de billet n’est pas valide. La référence d’un billet compte 8 caractères, par exemple 4F2A91C3.',
  NOT_FOUND: 'Aucun billet ne correspond à ce numéro. Vérifiez la référence sur votre billet ou sur votre e-mail de confirmation.',
  RATE_LIMITED: 'Trop de recherches en peu de temps. Patientez une minute avant de réessayer.',
};

/**
 * Tracking for a ticket number, with no account anywhere in the picture.
 *
 * WHO THIS IS FOR. Somebody who bought a ticket without creating an account —
 * the ordinary way to buy on LeRoutier — and who now wants to know where the
 * bus is. Requiring a login here would mean the account this product
 * deliberately does not require at purchase time is required at the one moment
 * the traveller is standing at a roadside. So the ticket number is the whole
 * of the credential, exactly as it is at the counter.
 *
 * The number is eight hex characters and therefore guessable, which is why the
 * answer behind it is a whitelisted operational projection — route, stops,
 * position, arrival — and why the endpoint it comes from meters every client
 * address. Nothing about this screen is protected by being hard to find.
 *
 * @param {{ reference?: string, onReferenceChange?: (value: string) => void, autoFocus?: boolean }} props
 */
export function TicketLookup({ reference = '', onReferenceChange }) {
  const { request, online } = useSession();
  const [value, setValue] = useState(reference);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const query = value.trim();
  // The number actually being watched, which is not the one in the box: the
  // field stays editable while a journey is on screen, and a poll must keep
  // asking about the ticket that was looked up rather than about whatever has
  // been typed since.
  const [asked, setAsked] = useState('');
  const [attempt, setAttempt] = useState(0);
  // A journey already answered for is never replaced by a poll's failure: a
  // rate limit or a dropped connection says nothing about the ticket, and
  // wiping the answer would report a problem that does not exist.
  const have = useRef(false);

  const set = next => { setValue(next); onReferenceChange?.(next); };

  useEffect(() => {
    if (!asked) return;
    let cancelled = false, timer = null, settled = false;
    async function load() {
      try {
        const data = await request(`/public/ticket-tracking/${encodeURIComponent(asked)}`);
        if (cancelled) return;
        have.current = true;
        setResult(data); setError('');
        // A finished or cancelled journey has nothing left to watch, so the
        // clock stops rather than asking a question whose answer is settled.
        settled = ['completed', 'cancelled'].includes(journeyState(data.ticket).key);
      } catch (e) {
        if (cancelled) return;
        if (!have.current) setError(LOOKUP_ERRORS[e.code] || e.message);
      } finally {
        if (!cancelled) { setBusy(false); if (!settled) timer = setTimeout(load, 20_000); }
      }
    }
    load();
    // Hidden tabs stop asking, exactly as a signed-in journey does.
    const onVisibility = () => { if (document.visibilityState === 'visible' && !timer && !settled) load(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { cancelled = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [asked, attempt, request]);

  const submit = useCallback(event => {
    event.preventDefault();
    const typed = query.toUpperCase();
    if (!typed) { input.current?.focus(); return; }
    setError('');
    if (typed === asked) { have.current = false; setBusy(true); setAttempt(n => n + 1); return; }
    have.current = false;
    setBusy(true);
    setResult(null);
    setAsked(typed);
  }, [query, asked]);

  const ticket = result?.ticket;

  return <div className="stack">
    <Card className="stack">
      <SectionTitle icon={Ticket} title="Suivre un billet"/>
      <p className="small muted" style={{ margin: 0 }}>
        Saisissez la référence de votre billet pour voir où en est le voyage.
        Aucun compte n’est nécessaire : la référence suffit.
      </p>
      <form className="stack" onSubmit={submit}>
        <label className="field">Référence du billet
          <input ref={input} className="control mono" name="reference" value={value}
            onChange={event => set(event.target.value)} placeholder="4F2A91C3"
            autoComplete="off" autoCapitalize="characters" spellCheck={false}
            maxLength={16} aria-describedby="ticket-reference-hint"/>
        </label>
        <span className="small muted" id="ticket-reference-hint">
          8 caractères, chiffres et lettres, affichés sous « Référence » sur votre billet.
        </span>
        <div className="controls">
          <button type="submit" className="btn btn-primary" disabled={busy || !online || !query}>
            <Search size={15}/>{busy ? 'Recherche…' : 'Afficher le suivi'}
          </button>
        </div>
      </form>
      {error && <p className="small" role="alert" style={{ margin: 0 }}>{error}</p>}
    </Card>

    {result && ticket && <TicketTrackingResult result={result}/>}
  </div>;
}

/** One looked-up ticket: the journey facts, then the journey itself. */
function TicketTrackingResult({ result }) {
  const { ticket, tracking } = result;
  const state = journeyState(ticket);
  const live = tracking && !['completed', 'cancelled'].includes(state.key);

  return <div className="stack">
    <Card className="stack">
      <div className="between wrap">
        <div>
          <h2>{ticket.departureCity} → {ticket.arrivalCity}</h2>
          <div className="small">{ticket.routeName}</div>
          <span className="small muted">{ticket.operatorName}</span>
        </div>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>
      <div className="ticket-grid">
        <div><span>Référence</span><strong className="ticket-code">{result.reference}</strong></div>
        <div><span>Départ</span><strong>{clock(ticket.departureAt) ?? '–'}</strong></div>
        <div><span>Départ prévu</span><strong>{new Date(ticket.departureAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</strong></div>
        {ticket.arrivalAt && <div><span>Arrivée prévue</span><strong>{clock(ticket.arrivalAt)}</strong></div>}
      </div>
      {ticket.isTest && <p className="small muted" role="status">Données de démonstration : ce départ n’existe pas en exploitation.</p>}
      {state.text && <p className="small muted" role="status" style={{ margin: 0 }}>{state.text}</p>}
    </Card>

    {live && tracking
      ? <TrackingPanel data={tracking} title="Où est le véhicule"/>
      /* No tracking at all is said in words. A blank space where a map should
         be is indistinguishable from a page that failed to load. */
      : !['completed', 'cancelled'].includes(state.key) && <Card className="stack">
        <SectionTitle icon={Navigation} title="Où est le véhicule"/>
        <p className="small muted" role="status" style={{ margin: 0 }}>
          Aucune position n’est disponible pour ce départ pour le moment. Le suivi apparaît
          dès que l’opérateur transmet la position du véhicule, généralement peu avant le départ.
        </p>
      </Card>}
  </div>;
}

/**
 * The small print about what a guest lookup does and does not reveal.
 *
 * Kept next to the screen that shows it: this is the sentence that stops
 * somebody assuming a map, a speed or an arrival hour exists when the service
 * has simply not sent one.
 */
export function TrackingPrivacyNote() {
  return <p className="small muted">
    <Lock size={13} aria-hidden="true" style={{ verticalAlign: '-2px' }}/> Le suivi public affiche la
    progression du véhicule et les arrêts. Il ne montre ni votre identité, ni votre téléphone, ni votre paiement.
  </p>;
}
