import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, SectionTitle, ApiState, ProfileForm, ErrorState, SkeletonCards } from '@leroutier/ui';
import { status, fcfa, time, dayShort, dayLong, dateTime, duration, reference, mapLink, placeLabel } from '@leroutier/ui';
import { QRCodeSVG } from 'qrcode.react';
import { Armchair, Ticket, Building2, Navigation, UserRound, ArrowLeftRight, CreditCard, Package, Store, MapPin, QrCode, Search, Lock } from 'lucide-react';
import { JourneySearchResults } from './journey-results.jsx';
import { rememberCheckout } from './checkout.jsx';
import { JourneyTimeline } from './journey.jsx';
import { JourneyTracking } from './tracking.jsx';
import { TicketDocuments, ParcelDocuments } from './documents.jsx';
import { QrCapture } from './qr-capture.jsx';
import { InsuranceOffer, InsurancePolicy } from './insurance.jsx';

const isoDay = value => new Date(value).toISOString().slice(0, 10);
const sameDay = (value, day) => isoDay(value) === day;

// Accent-insensitive folding, shared by every geography lookup in this file.
const foldText = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Accessible place autocomplete over the canonical Benin geography (77
 * communes). Completely independent of routes and services: geography is
 * where the passenger wants to go, transport inventory is what exists.
 */
export function PlaceCombobox({ label, placeholder, value, onSelect, onClear, inputId }) {
  const places = useApi('/places?type=commune');
  const [query, setQuery] = useState(''), [open, setOpen] = useState(false), [highlight, setHighlight] = useState(0);
  const inputRef = useRef(null), listRef = useRef(null), hadValue = useRef(false);
  const slug = (label || 'field').replace(/\s+/g, '-').toLowerCase();
  const listboxId = `listbox-${slug}`;
  const communes = (places.data || []).filter(p => !query.trim() ||
    foldText(`${p.name} ${p.normalized_name ?? ''} ${(p.aliases ?? []).join(' ')}`).includes(foldText(query)));
  const selected = communes.find(p => p.id === value) ?? null;
  // Clearing a selection remounts the input and returns focus to it.
  useEffect(() => {
    if (value) { hadValue.current = true; return; }
    if (hadValue.current) { hadValue.current = false; inputRef.current?.focus(); }
  }, [value]);
  // The keyboard highlight always stays inside the scrollable list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`#${listboxId}-opt-${highlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, highlight, listboxId]);
  function choose(p) { onSelect(p.id); setQuery(''); setOpen(false); inputRef.current?.blur(); }
  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); setHighlight(0); }
      else setHighlight(h => Math.min(h + 1, communes.length - 1));
    } else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter' && open && communes[highlight]) { e.preventDefault(); choose(communes[highlight]); }
    else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
    else setOpen(true);
  }
  return <div className="place-combobox">
    <label className="field" htmlFor={inputId}>{label}</label>
    <div className="combobox-control">
      {value && selected ? <button type="button" className="combobox-chip" aria-label={`${label} : ${selected.name}. Effacer`}
        onClick={onClear}>{selected.name}<span aria-hidden="true">×</span></button>
        : <input ref={inputRef} id={inputId} className="control" role="combobox" aria-expanded={open}
          aria-controls={open ? listboxId : undefined} aria-activedescendant={open ? `${listboxId}-opt-${highlight}` : undefined}
          aria-label={label} aria-autocomplete="list" placeholder={placeholder} value={query}
          onChange={e => { setQuery(e.target.value); setHighlight(0); setOpen(true); }}
          onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey}/>}
      <span className="small muted" role="status" aria-live="polite">
        {places.loading ? 'Chargement des villes…'
          : places.error ? 'Impossible de charger les villes pour le moment.'
            : value && selected ? `${label} sélectionné : ${selected.name}.`
              : !places.data?.length ? 'Aucune ville disponible pour le moment.'
                : open && query && communes.length === 0 ? 'Aucune ville trouvée.' : ''}
      </span>
    </div>
    {open && !value && <ul className="combobox-list" role="listbox" id={listboxId} ref={listRef}>
      {communes.slice(0, 50).map((p, i) => <li key={p.id} id={`${listboxId}-opt-${i}`} role="option" aria-selected={i === highlight}
        className={i === highlight ? 'highlight' : ''} onMouseDown={e => { e.preventDefault(); choose(p); }}>{p.name}</li>)}
    </ul>}
  </div>;
}

/**
 * The journey search fields, shared by the public home and the results
 * screen. Origin defaults to "Ma position"; both origin and
 * destination are canonical Benin geography — never the route inventory.
 */
export function JourneySearchFields({ originMode, setOriginMode, originPlace, setOriginPlace, destinationPlace, setDestinationPlace, day, setDay, onSearch, onSwap, submitLabel = 'Rechercher un trajet' }) {
  const [minDay] = useState(() => isoDay(Date.now()));
  const same = originMode === 'place' && originPlace && originPlace === destinationPlace;
  const swappable = destinationPlace && (originMode === 'current' || originPlace);
  return <form className="trip-search stack" onSubmit={onSearch}>
    <div className="trip-endpoints">
      <div className="endpoint-cell">
        <label className="field" htmlFor="trip-origin">Départ
          <select id="trip-origin" className="control" aria-label="Départ" value={originMode} onChange={e => setOriginMode(e.target.value)}>
            {/* "Ma position", not "Ma position actuelle": this cell is 120px on
                a phone and a <select> truncates its own option, so the longer
                label rendered as "Ma position" with the tail cut off anyway.
                Same meaning, no visible amputation. */}
            <option value="current">Ma position</option>
            <option value="place">Choisir une ville…</option>
          </select>
        </label>
        {/* An example, not a restatement of the label above it. These cells are
            120px wide on a phone, where "Rechercher une ville ou une localité"
            rendered as "Rechercher une" and stopped mid-sentence. A city name
            fits, and it also answers the question the label does not: what
            kind of thing do I type here. */}
        {originMode === 'place' && <PlaceCombobox label="Ville de départ" placeholder="Ex. Cotonou" inputId="trip-origin-place"
          value={originPlace} onSelect={setOriginPlace} onClear={() => setOriginPlace(null)}/>}
      </div>
      <button type="button" className="swap-btn" aria-label="Inverser départ et arrivée" disabled={!swappable} onClick={onSwap}><ArrowLeftRight size={17}/></button>
      <div className="endpoint-cell">
        <PlaceCombobox label="Destination" placeholder="Ex. Parakou" inputId="trip-destination"
          value={destinationPlace} onSelect={setDestinationPlace} onClear={() => setDestinationPlace(null)}/>
      </div>
    </div>
    <label className="field" htmlFor="trip-date">Date
      <input id="trip-date" className="control" type="date" aria-label="Date" value={day} min={minDay} onChange={e => setDay(e.target.value)}/>
    </label>
    {same && <p className="small muted" role="status">Choisissez deux villes différentes.</p>}
    <button className="btn btn-primary" type="submit" disabled={!destinationPlace || (originMode === 'place' && !originPlace) || same}><Search size={16}/>{submitLabel}</button>
  </form>;
}

/** Public home hero: the single most important action in the product. */
// The corridors people actually ask for, offered as one tap instead of two
// pickers. Each pill is resolved against the real geography the API serves:
// a corridor whose endpoints do not both exist simply is not shown, so this
// can never advertise a route LeRoutier has no places for. Tapping one runs
// the ordinary search, which still answers honestly when nothing is published.
//
// The LIST itself arrives as a prop and is not defined here. It used to be a
// second hardcoded array beside the footer's catalogue, and the two drifted:
// the home page offered Abomey-Calavi and Ouidah, the footer offered
// Sèmè-Kpodji, Lokossa, Malanville and Parakou–Natitingou, and only four pairs
// appeared in both. One product, one answer to "where do people go".
const foldName = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function CorridorPills({ corridors = [], onPick }) {
  const places = useApi('/places?type=commune');
  const byName = useMemo(() => {
    const index = new Map();
    for (const place of places.data || []) index.set(foldName(place.name), place);
    return index;
  }, [places.data]);
  const available = useMemo(() => corridors
    .map(({ from, to }) => ({ from: byName.get(foldName(from)), to: byName.get(foldName(to)) }))
    .filter(pair => pair.from && pair.to), [byName, corridors]);
  if (!available.length) return null;
  return <div className="corridor-pills">
    <span className="small muted" id="corridor-pills-label">Trajets fréquents</span>
    <div className="corridor-pill-row" role="group" aria-labelledby="corridor-pills-label">
      {available.map(({ from, to }) => <button key={from.id + to.id} type="button" className="corridor-pill"
        onClick={() => onPick(from.id, to.id)}>{from.name} → {to.name}</button>)}
    </div>
    <span className="small muted">Vous pouvez aussi descendre à une étape intermédiaire : le tarif correspond au trajet réellement parcouru.</span>
  </div>;
}

export function TripSearchHero({ corridors = [] }) {
  const navigate = useNavigate();
  const [originMode, setOriginMode] = useState('current');
  const [originPlace, setOriginPlace] = useState(null);
  const [destinationPlace, setDestinationPlace] = useState(null);
  const [day, setDay] = useState(() => isoDay(Date.now()));
  function swap() {
    if (originMode === 'place' && originPlace) { setOriginPlace(destinationPlace); setDestinationPlace(originPlace); }
    else { setOriginMode('place'); setOriginPlace(destinationPlace); setDestinationPlace(null); }
  }
  function search(e) {
    e.preventDefault();
    // `place:` namespaces geography ids: stop ids from legacy deep links live
    // in the same parameter space and must never be confused with places.
    const params = new URLSearchParams({ date: day });
    params.set('from', originMode === 'current' ? 'my-location' : `place:${originPlace}`);
    params.set('to', `place:${destinationPlace}`);
    if (new URLSearchParams(window.location.search).get('testMode') === '1') params.set('testMode', '1');
    navigate(`/trips?${params}`);
  }
  return <Card className="hero stack">
    <span className="eyebrow">Voyager</span>
    <h1>Où allez-vous ?</h1>
    <p>Recherchez un trajet partout au Bénin.</p>
    <JourneySearchFields originMode={originMode} setOriginMode={setOriginMode}
      originPlace={originPlace} setOriginPlace={setOriginPlace}
      destinationPlace={destinationPlace} setDestinationPlace={setDestinationPlace}
      day={day} setDay={setDay} onSearch={search} onSwap={swap}/>
    <CorridorPills corridors={corridors} onPick={(from, to) => {
      const params = new URLSearchParams({ date: day, from: `place:${from}`, to: `place:${to}` });
      if (new URLSearchParams(window.location.search).get('testMode') === '1') params.set('testMode', '1');
      navigate(`/trips?${params}`);
    }}/>
    <span className="small muted">Aucun compte nécessaire pour rechercher.</span>
  </Card>;
}

/** One leg of a trip: a dot, the place, and its landmark. */
function Leg({ city, point, landmark, end = false }) {
  return <div className="trip-leg">
    <div className={`trip-dot ${end ? 'end' : ''}`}/>
    <div>
      <strong>{city}</strong>
      {placeLabel(point, landmark) && <span className="small muted"> · {placeLabel(point, landmark)}</span>}
    </div>
  </div>;
}

// The results experience (offer comparison, detail and map) lives in
// journey-results.jsx; the geolocation state stays here so the map can draw
// the requested origin for both current-position and place searches.

const IS_UUID = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v ?? '');

export function Trips() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // A search started on the home page continues here unchanged. New links
  // namespace geography ids as `place:<uuid>`; stop ids from legacy deep
  // links live in the same parameter space and stay on the old service list.
  const fromParam = params.get('from') || '', toParam = params.get('to') || '';
  const [originMode, setOriginMode] = useState(() => fromParam === 'my-location' ? 'current' : fromParam ? 'place' : 'current');
  const [originPlace, setOriginPlace] = useState(() => fromParam.startsWith('place:') ? fromParam.slice(6) : null);
  const [destinationPlace, setDestinationPlace] = useState(() => toParam.startsWith('place:') ? toParam.slice(6) : null);
  const [day, setDay] = useState(() => { const p = params.get('date') || ''; return p >= isoDay(Date.now()) ? p : isoDay(Date.now()); });
  const [searched, setSearched] = useState(() => Boolean(toParam));
  const legacyStops = IS_UUID(fromParam) && IS_UUID(toParam);
  const legacyStopDest = IS_UUID(toParam);
  // Geolocation is requested only when the search needs it; the position is
  // transient and never stored. The canonical geography supplies place names
  // and coordinates for the summary and the map.
  const [position, setPosition] = useState(null), [geoState, setGeoState] = useState('idle'), [geoError, setGeoError] = useState('');
  const places = useApi('/places?type=commune');
  function locate() {
    setGeoState('asking'); setGeoError('');
    if (!navigator.geolocation) { setGeoState('denied'); setGeoError('La géolocalisation n’est pas disponible sur cet appareil. Choisissez votre ville de départ.'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => { setPosition({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }); setGeoState('granted'); },
      () => { setGeoState('denied'); setGeoError('Position non disponible. Choisissez votre ville de départ.'); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
  }
  const placeById = id => (places.data || []).find(p => p.id === id) ?? null;
  const originPlaceRow = placeById(originPlace);
  const destinationPlaceRow = placeById(destinationPlace);
  const originPoint = (originMode === 'current' ? position : null) ?? (originPlaceRow ? { latitude: Number(originPlaceRow.latitude), longitude: Number(originPlaceRow.longitude), label: originPlaceRow.name } : null);
  const destinationPoint = destinationPlaceRow ? { latitude: Number(destinationPlaceRow.latitude), longitude: Number(destinationPlaceRow.longitude), label: destinationPlaceRow.name } : null;

  function swap() {
    if (originMode === 'place' && originPlace) { setOriginPlace(destinationPlace); setDestinationPlace(originPlace); }
    else { setOriginMode('place'); setOriginPlace(destinationPlace); setDestinationPlace(null); }
  }
  function search(e) {
    e.preventDefault();
    const next = new URLSearchParams({ date: day });
    if (params.get('testMode') === '1') next.set('testMode', '1');
    next.set('from', originMode === 'current' ? 'my-location' : `place:${originPlace}`);
    next.set('to', `place:${destinationPlace}`);
    setParams(next);
    setSearched(true);
  }
  // The empty-result actions lead back to the exact control, not away from
  // the screen: the search form stays visible above the results.
  const focusField = id => {
    document.getElementById('trip-search')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById(id)?.focus();
  };
  const editDate = () => focusField('trip-date');
  const editOrigin = () => {
    if (originMode === 'place' && originPlace) setOriginPlace(null);
    focusField('trip-origin');
  };
  const editDestination = () => {
    setDestinationPlace(null);
    requestAnimationFrame(() => focusField('trip-destination'));
  };

  // Selecting an offer does NOT authenticate. It creates an anonymous
  // checkout intent and moves to /checkout; authentication begins only on
  // "Continuer vers le paiement".
  function choose(option) {
    rememberCheckout({
      serviceId: option.serviceId, originSequence: option.originSequence, destinationSequence: option.destinationSequence,
      option,
      originLabel: originPlaceRow?.name ?? option.pickupStop?.city ?? null,
      destinationLabel: destinationPlaceRow?.name ?? option.dropoffStop?.city ?? null,
      search: { from: fromParam, to: toParam, date: day, testMode: params.get('testMode') === '1' },
    });
    navigate('/checkout');
  }
  // The legacy stop-id list speaks service rows; its offers are shaped into
  // the same option form the checkout understands.
  const legacyOption = s => {
    const a = s.availability, seats = a.available;
    return {
      serviceId: s.id, originSequence: a.origin, destinationSequence: a.destination,
      operatorName: s.operator_name, operatorType: s.operator_type ?? 'company', routeName: s.route_name,
      departureAt: s.departure_at, serviceStatus: s.status,
      pickupStop: { name: s.departure_point_name ?? 'Point de prise en charge', city: a.stops[a.origin]?.city },
      dropoffStop: { name: s.arrival_point_name ?? 'Point de descente', city: a.stops[a.destination]?.city },
      vehicle: { registration: s.registration ?? null, model: null },
      intermediateStops: (a.stops ?? []).slice(a.origin, a.destination + 1).map((st, i) => ({ sequence: a.origin + i, city: st.city })),
      routeGeometry: null, livePosition: null,
      fare: { amountMinor: a.fare.amountMinor, currency: a.fare.currency },
      available: seats, capacity: a.capacity ?? seats, feasible: seats > 0,
      firstMile: null, waitingS: 0, intercity: { durationS: null, etaAt: s.arrival_at }, lastMile: null,
      totalDurationS: null, etaAt: s.arrival_at, isTest: s.is_demo === true,
    };
  };

  return <>
    <Card className="hero stack">
      <span className="eyebrow">Voyager</span>
      <h1>Trouvez votre départ.</h1>
      <p>Recherchez librement. Le compte n’est demandé qu’au moment de réserver.</p>
    </Card>

    <div id="trip-search">
      <Card className="stack">
        <JourneySearchFields originMode={originMode} setOriginMode={setOriginMode}
          originPlace={originPlace} setOriginPlace={setOriginPlace}
          destinationPlace={destinationPlace} setDestinationPlace={setDestinationPlace}
          day={day} setDay={setDay} onSearch={search} onSwap={swap} submitLabel="Rechercher un trajet"/>
        <span className="small muted">1 place par réservation · paiement en ligne sécurisé</span>
      </Card>
    </div>

    {searched && (destinationPlace || legacyStopDest) && (legacyStops
      ? <LegacyServiceList originStopId={fromParam} destinationStopId={toParam} day={day}
          choose={s => choose(legacyOption(s))}/>
      : <JourneySearchResults originMode={originMode} originPlace={originPlace}
          destinationPlace={destinationPlace} destinationStopId={legacyStopDest ? toParam : null}
          day={day} choose={choose}
          onEditDate={editDate} onEditOrigin={editOrigin} onEditDestination={editDestination}
          originPoint={originPoint} destinationPoint={destinationPoint}
          position={position} geoState={geoState} geoError={geoError} onLocate={locate}/>)}
  </>;
}

// Legacy renderer for stop-id deep links: the service list of the previous
// search model, kept for links already in circulation. Selection leads to
// the anonymous checkout like every other offer.
function LegacyServiceList({ originStopId, destinationStopId, day, choose }) {
  const { online } = useSession();
  const [anyDay, setAnyDay] = useState(false);
  const services = useApi(`/services?originStopId=${originStopId}&destinationStopId=${destinationStopId}`);
  const all = services.data || [];
  const onDay = all.filter(s => sameDay(s.departure_at, day));
  const showingNext = !anyDay && onDay.length === 0 && all.length > 0;
  const shown = anyDay || showingNext ? all : onDay;
  return <><SectionTitle title={anyDay || showingNext ? 'Prochains départs' : `Départs du ${dayLong(day)}`}/>
    {showingNext && <p className="small muted" role="status">Aucun départ le {dayLong(day)} : voici les prochains départs sur ce trajet.</p>}
    {services.loading ? <SkeletonCards count={2} lines={4}/>
      : services.error ? <ErrorState text="Impossible de charger les départs." onRetry={services.reload}/>
        : !shown.length ? <Card className="stack">
          <strong>Aucun départ disponible pour cet itinéraire pour le moment.</strong>
          <p className="small muted">Ce trajet n’est pas encore desservi. Essayez une autre date.</p>
          <div className="controls"><button className="btn btn-soft" onClick={() => setAnyDay(true)}>Voir les prochains départs</button></div>
        </Card>
          : shown.map(service => {
            const a = service.availability, seats = a.available;
            const trip = duration(service.departure_at, service.arrival_at);
            return <Card key={service.id} className="trip-card">
              <div className="between wrap">
                <div className="trip-times">
                  <strong>{time(service.departure_at)}</strong>
                  <span className="arrow">→</span>
                  <strong>{service.arrival_at ? time(service.arrival_at) : '–'}</strong>
                  {trip && <span className="trip-duration">{trip}</span>}
                </div>
                {anyDay && <Badge tone="neutral">{dayShort(service.departure_at)}</Badge>}
              </div>
              <div className="stack">
                <Leg city={a.stops[a.origin].city} point={service.departure_point_name} landmark={service.departure_point_landmark}/>
                <Leg city={a.stops[a.destination].city} point={service.arrival_point_name} landmark={service.arrival_point_landmark} end/>
              </div>
              <div className="trip-foot">
                <div>
                  <strong className="small">{service.operator_name}</strong>
                  <div><Badge tone={seats > 2 ? 'success' : seats ? 'warning' : 'danger'}><Armchair size={13}/>{seats ? `${seats} place${seats > 1 ? 's' : ''}` : 'Complet'}</Badge></div>
                </div>
                <div className="end">
                  <span className="trip-price">{fcfa(a.fare.amountMinor)}</span>
                  {service.is_demo && <Badge tone="danger">TEST</Badge>}
                  {/* No login at selection: choosing opens the anonymous checkout. */}
                  <button className="btn btn-primary" disabled={!online || !seats} onClick={() => choose(service)}>Choisir</button>
                </div>
              </div>
            </Card>;
          })}
  </>;
}

// ── Tickets ────────────────────────────────────────────────────────────────
// One card per trip. The state drives exactly one primary action: pay, then
// show the ticket. The QR leads once the trip is confirmed.
export function Tickets({ focusId = null }) {
  const { user, request, online } = useSession();
  const bookings = useApi(user ? '/me/bookings' : null);
  const paymentsConfig = useApi('/payments/config');
  const navigate = useNavigate();
  const [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [openedTicket, setOpenedTicket] = useState(null), [payStates, setPayStates] = useState({});
  const ticketOpener = useRef(null);
  const onlinePayments = paymentsConfig.data?.available === true;

  // Signing out on a shared handset must take every ticket code off the screen.
  // The list is hidden behind the sign-in panel, but the opened QR used to stay
  // rendered until the next sign-in because the state outlived the session.
  // Adjusted during render rather than in an effect: React immediately
  // re-renders with the cleared state, and the guarded condition keeps the
  // adjustment from looping.
  if (!user && (openedTicket || error || Object.keys(payStates).length > 0)) {
    setOpenedTicket(null); setPayStates({}); setError('');
  }

  // After returning from the payment page, poll trusted server state: only the
  // provider's verified callback can confirm a booking.
  const dataRef = useRef(bookings.data), reloadRef = useRef(bookings.reload);
  useEffect(() => { dataRef.current = bookings.data; reloadRef.current = bookings.reload; });
  const heldKey = (bookings.data || []).filter(b => b.status === 'held').map(b => b.id).sort().join(',');
  useEffect(() => {
    if (!user || !heldKey) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        for (const b of (dataRef.current || []).filter(x => x.status === 'held')) {
          const payments = await request(`/bookings/${b.id}/payment-status`);
          const state = payments.some(p => p.status === 'succeeded') ? 'succeeded'
            : payments.some(p => p.status === 'pending') ? 'pending'
              : payments.some(p => p.status === 'failed' || p.status === 'cancelled') ? 'failed' : 'none';
          if (!cancelled) setPayStates(prev => ({ ...prev, [b.id]: state }));
        }
        reloadRef.current();
      } catch { /* transient polling failures stay silent */ }
    }, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [user, heldKey, request]);

  async function act(id, verb) {
    setBusy(id); setError('');
    try { await request(`/bookings/${id}/${verb}`, { method: 'POST' }); bookings.reload(); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  async function pay(id) {
    setBusy(id); setError('');
    try {
      const intent = await request(`/bookings/${id}/payment-intents`, { method: 'POST', key: 'pay-' + id, body: {} });
      setPayStates(prev => ({ ...prev, [id]: 'pending' }));
      if (intent.checkoutUrl) window.location.assign(intent.checkoutUrl);
      else setError('Le lien de paiement est indisponible. Réessayez dans un instant.');
    } catch (e) {
      setError(e.code === 'PAYMENT_UNAVAILABLE' ? 'Le paiement en ligne est momentanément indisponible.' : e.message);
    } finally { setBusy(''); }
  }
  async function issue(id, opener) {
    ticketOpener.current = opener;
    setBusy(id); setError('');
    try {
      const ticket = await request(`/bookings/${id}/ticket`, { method: 'POST', body: {} });
      setOpenedTicket(ticket);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  // A deep-linked booking leads; the rest follow.
  const list = useMemo(() => {
    const rows = bookings.data || [];
    return focusId ? [...rows].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0)) : rows;
  }, [bookings.data, focusId]);

  return <>
    <SectionTitle icon={Ticket} title="Mes billets"/>
    {openedTicket?.document && <TicketDocuments ticket={openedTicket} onClose={() => { setOpenedTicket(null); requestAnimationFrame(() => ticketOpener.current?.focus()); }}/>}
    {openedTicket && !openedTicket.document && <div className="ticket-qr"><QRCodeSVG value={openedTicket.token} size={190} marginSize={4}/><span className="ticket-code">{openedTicket.manualCode}</span></div>}
    {error && <ErrorState title="Action impossible" text={error}/>}
    {!user ? <ApiState resource={{ loading: false, error: null }} emptyTitle="Connectez-vous"
      empty="Vos billets et réservations apparaissent ici une fois connecté."/>
      : bookings.loading ? <SkeletonCards count={2} lines={5}/>
        : bookings.error ? <ErrorState text="Impossible de charger vos billets." onRetry={bookings.reload}/>
          : !list.length ? <Card className="stack">
            <strong>Aucun voyage pour le moment</strong>
            <p className="small muted">Trouvez un départ et réservez votre place en quelques secondes.</p>
            <div className="controls"><button className="btn btn-primary" onClick={() => navigate('/trips')}><Search size={15}/>Rechercher un trajet</button></div>
          </Card>
            : list.map(b => {
              const state = status('booking', b.status);
              const pay$ = payStates[b.id] ?? 'none';
              return <Card key={b.id} className="ticket">
                <div className="ticket-head between wrap">
                  <div>
                    <h2>{b.departure_city} → {b.arrival_city}</h2>
                    <div className="small">{b.route_name}</div>
                    <span className="small">{dateTime(b.departure_at)}</span>
                  </div>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </div>
                <div className="ticket-body stack">
                  <div className="ticket-grid">
                    <div><span>Embarquement</span><strong>{placeLabel(b.departure_point_name, null) || b.departure_city}</strong></div>
                    <div><span>Siège</span><strong>{b.seat_number}</strong></div>
                    <div><span>Référence</span><strong className="ticket-code">{reference(b.id)}</strong></div>
                    <div><span>Prix</span><strong>{fcfa(b.amount_minor)}</strong></div>
                  </div>
                  {b.departure_point_landmark && <span className="small muted">{b.departure_point_landmark}</span>}
                  {mapLink(b.departure_point_latitude, b.departure_point_longitude, 16) &&
                    <a className="small" href={mapLink(b.departure_point_latitude, b.departure_point_longitude, 16)} target="_blank" rel="noreferrer">
                      <MapPin size={13}/> Voir le point d’embarquement</a>}

                  {b.status === 'held' && <div className="payment-box stack">
                    <div className="between wrap">
                      <Badge tone={status('payment', pay$).tone}><CreditCard size={13}/>{status('payment', pay$).label}</Badge>
                      <span className="small muted">Place gardée jusqu’à {time(b.expires_at)}</span>
                    </div>
                    {pay$ === 'succeeded'
                      ? <button className="btn btn-primary" disabled={!!busy || !online} onClick={() => act(b.id, 'confirm')}>Confirmer ma réservation</button>
                      : onlinePayments
                        ? <button className="btn btn-primary" disabled={!!busy || !online} onClick={() => pay(b.id)}>
                          {busy === b.id ? 'Ouverture du paiement…' : pay$ === 'failed' ? 'Réessayer le paiement' : 'Payer en ligne'}</button>
                        : <p className="small muted" role="status">Le paiement en ligne est momentanément indisponible. Votre place sera libérée automatiquement : aucun billet n’est émis sans paiement.</p>}
                    {pay$ === 'pending' && <p className="small muted">Nous attendons la confirmation de votre paiement. Cette page se met à jour toute seule.</p>}
                  </div>}

                  {['confirmed', 'boarded', 'completed', 'cancelled', 'expired'].includes(b.status) &&
                    <button className="btn btn-primary" disabled={busy === b.id} onClick={e => issue(b.id, e.currentTarget)}><QrCode size={16}/>{busy === b.id ? 'Ouverture du billet…' : 'Afficher mon billet'}</button>}

                  {/* The cover, if there is one. Renders nothing when there is
                      not, so a booking without insurance looks exactly as it
                      did before this feature existed. */}
                  <InsurancePolicy scope="trip" subjectId={b.id}/>

                  <div className="controls">
                    {['confirmed', 'boarded'].includes(b.status) &&
                      <button className="btn btn-soft" onClick={() => navigate(`/tickets/${b.id}`)}><Navigation size={15}/>Mon trajet de bout en bout</button>}
                    {['held', 'confirmed'].includes(b.status) &&
                      <button className="btn btn-soft" disabled={!!busy || !online} onClick={() => act(b.id, 'cancel')}>Annuler</button>}
                  </div>
                </div>
              </Card>;
            })}
  </>;
}

export function Stations() {
  const stops = useApi('/stops');
  return <>
    <SectionTitle icon={Building2} title="Gares & points d’arrêt"/>
    {stops.loading ? <SkeletonCards count={3} lines={2}/>
      : stops.error ? <ErrorState text="Impossible de charger les points d’arrêt." onRetry={stops.reload}/>
        : !stops.data?.length ? <ApiState resource={stops} emptyTitle="Aucun point publié"
          empty="Les gares et arrêts apparaissent ici dès qu’une ligne est ouverte."/>
          : stops.data.map(s => <Card key={s.id} className="between wrap">
            <div><h3>{s.city}</h3><span className="small muted">{s.name}</span></div>
            {/* Coordinates drive a map link; they are never the interface. */}
            {mapLink(s.latitude, s.longitude, 16) &&
              <a className="btn btn-soft" href={mapLink(s.latitude, s.longitude, 16)} target="_blank" rel="noreferrer"><MapPin size={15}/>Voir sur la carte</a>}
          </Card>)}
  </>;
}

export function Tracking() {
  const { user } = useSession();
  const navigate = useNavigate();
  const bookings = useApi(user ? '/me/bookings' : null);
  const booking = bookings.data?.find(b => ['confirmed', 'boarded'].includes(b.status));
  return <>
    <SectionTitle icon={Navigation} title="Suivi de mon trajet"/>
    {!user ? <ApiState resource={{ loading: false, error: null }} emptyTitle="Connectez-vous"
      empty="Le suivi s’affiche pour vos trajets confirmés."/>
      : bookings.loading ? <SkeletonCards count={1} lines={3}/>
        : !booking ? <Card className="stack">
          <strong>Aucun trajet en cours</strong>
          <p className="small muted">Le suivi du véhicule s’active une fois votre réservation confirmée.</p>
          <div className="controls"><button className="btn btn-primary" onClick={() => navigate('/trips')}>Rechercher un trajet</button></div>
        </Card>
          : <div className="stack">
            <Card className="stack">
              <div className="between wrap">
                <div><h2>{booking.departure_city} → {booking.arrival_city}</h2><span className="small muted">{dateTime(booking.departure_at)}</span></div>
                <Badge tone={status('booking', booking.status).tone}>{status('booking', booking.status).label}</Badge>
              </div>
              <button className="btn btn-soft" onClick={() => navigate(`/tickets/${booking.id}`)}>Ouvrir mon trajet complet</button>
            </Card>
            <JourneyTracking bookingId={booking.id}/>
            <JourneyTimeline bookingId={booking.id}/>
          </div>}
  </>;
}

// ── Privacy center ──────────────────────────────────────────────────────────
// "Confidentialité et données": the user's own data, one coherent place for
// exports, consents, correction requests, account deletion and retention.
// French-first, simple actions; the API enforces ownership on every call.
export function PrivacyCenter() {
  const { user, request, online } = useSession();
  const summary = useApi(user ? '/me/privacy' : null);
  const consents = useApi(user ? '/me/consents' : null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [correction, setCorrection] = useState({ subject: '', description: '' });
  const act = async (path, body, method = 'POST') => {
    setBusy(true); setError(''); setNotice('');
    try { const r = await request(path, { method, body }); setNotice('Action enregistrée.'); summary.reload(); consents.reload(); return r; }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const marketing = (consents.data || []).find(c => c.consent_type === 'marketing' && c.status === 'accepted');
  async function download() {
    setError(''); setNotice('Préparation de votre export…');
    try {
      const created = await request('/me/data-export', { method: 'POST', body: {} });
      const payload = await request(`/me/data-export/${created.token}`);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'leroutier-mes-donnees.json'; a.click();
      URL.revokeObjectURL(url);
      setNotice('Export téléchargé. Le fichier contient uniquement vos données.');
    } catch (e) { setError(e.message); setNotice(''); }
  }
  const deletionStatus = summary.data?.deletion;
  const blockers = Array.isArray(deletionStatus?.blockers) ? deletionStatus.blockers : [];
  return <Card className="stack">
    <SectionTitle icon={Lock} title="Confidentialité et données"/>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {summary.loading || !summary.data ? <p role="status">Chargement de vos données…</p> : <>
      <details className="stack"><summary>Mes données</summary>
        <ul className="stack">
          {summary.data.categories.map(c => <li key={c.category} className="between"><span>{c.category}</span><span className="small muted">{c.count}</span></li>)}
        </ul>
        <p className="small muted">Les positions GPS brutes des services terminés sont conservées 30 jours, sauf incident, litige ou obligation légale.</p>
      </details>
      <details className="stack"><summary>Politique de conservation des données</summary>
        <ul className="stack">{summary.data.retention.map(r => <li key={r.data_category} className="between"><span>{r.data_category}</span><span className="small muted">{r.retention_days} jours · {r.action}</span></li>)}</ul>
        <p className="small muted">Durées opérationnelles par défaut, susceptibles d’être ajustées après validation juridique.</p>
      </details>
      <div className="between wrap">
        <span><strong>Télécharger mes données</strong><br/><span className="small muted">Un fichier avec vos informations, valable 24 h.</span></span>
        <button className="btn btn-soft" disabled={busy || !online} onClick={download}>Télécharger</button>
      </div>
      <div className="stack">
        <strong>Corriger mes informations</strong>
        <input className="control" placeholder="Sujet (ex. nom, téléphone)" value={correction.subject} onChange={e => setCorrection(s => ({ ...s, subject: e.target.value }))} aria-label="Sujet de la correction"/>
        <textarea className="control" placeholder="Décrivez la correction demandée" rows={2} value={correction.description} onChange={e => setCorrection(s => ({ ...s, description: e.target.value }))} aria-label="Description de la correction"/>
        <button className="btn btn-soft" disabled={busy || !online || correction.subject.trim().length < 2 || correction.description.trim().length < 2}
          onClick={() => act('/me/privacy/corrections', correction).then(() => setCorrection({ subject: '', description: '' }))}>Envoyer la demande</button>
      </div>
      <div className="between wrap">
        <span><strong>Mes consentements</strong><br/><span className="small muted">Communications commerciales facultatives. Les notifications de service restent toujours actives.</span></span>
        <button className="btn btn-soft" disabled={busy || !online}
          onClick={() => marketing ? act('/me/consents/marketing', undefined, 'DELETE') : act('/me/consents', { consentType: 'marketing', policyVersion: 'v1' })}>
          {marketing ? 'Désactiver les communications commerciales' : 'Activer les communications commerciales'}
        </button>
      </div>
      {summary.data.account.retentionDueAt && <div className="between wrap">
        <span><strong>Conserver mon compte</strong><br/><span className="small muted">Votre compte est inactif depuis un certain temps.</span></span>
        <button className="btn btn-primary" disabled={busy || !online} onClick={() => act('/me/retention-confirmation', undefined, 'POST')}>Conserver mon compte</button>
      </div>}
      <div className="stack">
        <strong>Supprimer mon compte</strong>
        {deletionStatus ? <p role="status">Votre demande est « {deletionStatus.status} »{blockers.length ? ` : en attente : ${blockers.map(b => ({ active_booking: 'réservation active', pending_payment: 'paiement en attente', active_parcel: 'colis en cours' })[b.kind] ?? b.kind).join(', ')}` : ''}. Nous vous informerons du résultat.</p>
          : confirmDelete ? <div className="stack">
            <p className="small muted">Votre identité de connexion et vos données seront supprimées ou anonymisées. Certaines données (paiements, réservations, colis, preuves de sécurité) peuvent être conservées pour des raisons légales, comptables ou de litiges. Les voyages, colis ou paiements en cours seront d’abord clôturés.</p>
            <div className="controls">
              <button className="btn btn-danger" disabled={busy || !online} onClick={() => act('/me/deletion-request', undefined, 'POST')}>Confirmer la suppression</button>
              <button className="btn btn-soft" onClick={() => setConfirmDelete(false)}>Annuler</button>
            </div>
          </div>
          : <button className="btn btn-soft" disabled={busy || !online} onClick={() => setConfirmDelete(true)}>Demander la suppression de mon compte</button>}
      </div>
    </>}
  </Card>;
}

// Which professional workspace this identity actually holds. Derived from the
// identity the API returned, never from a stored preference, and never a
// switcher: a passenger is offered nothing here, and the API re-checks anyway.
function professionalWorkspace(user) {
  if (user?.role === 'ops') return user.operator_id
    ? { label: 'Ouvrir mon espace exploitation', to: '/ops/today' }
    : { label: 'Ouvrir l’exploitation plateforme', to: '/ops/platform' };
  if (user?.role === 'convoyeur') return { label: 'Ouvrir mon espace convoyeur', to: '/work/today' };
  return { label: 'Ouvrir mon espace chauffeur', to: '/work/today' };
}

export function Account() {
  const { user } = useSession();
  const navigate = useNavigate();
  const bookings = useApi(user ? '/me/bookings' : null);
  const parcels = useApi(user ? '/me/parcels' : null);
  // The account screen leads with what is happening, not with settings.
  const next = (bookings.data || [])
    .filter(b => ['held', 'confirmed', 'boarded'].includes(b.status))
    .sort((a, b) => Date.parse(a.departure_at) - Date.parse(b.departure_at))[0];
  const parcel = (parcels.data || [])[0];
  return <>
    <SectionTitle icon={UserRound} title="Mon compte"/>
    {!user ? <Card className="stack">
      <strong>Connectez-vous</strong>
      <p className="small muted">Retrouvez vos billets, vos envois et vos notifications.</p>
    </Card> : <>
      {next && <Card className="card-primary stack">
        <span className="eyebrow" style={{ color: '#fff', opacity: .85 }}>Prochain voyage</span>
        <h2>{next.departure_city} → {next.arrival_city}</h2>
        <span className="small">{dateTime(next.departure_at)} · {placeLabel(next.departure_point_name, null) || next.departure_city}</span>
        <div className="controls"><button className="btn btn-dark" onClick={() => navigate(`/tickets/${next.id}`)}>Voir mon billet</button></div>
      </Card>}
      {!next && !bookings.loading && <Card className="stack">
        <strong>Aucun voyage prévu</strong>
        <p className="small muted">Réservez votre prochain trajet en quelques secondes.</p>
        <div className="controls"><button className="btn btn-primary" onClick={() => navigate('/trips')}><Search size={15}/>Rechercher un trajet</button></div>
      </Card>}
      {parcel && <Card className="between wrap">
        <div><span className="small muted">Dernier envoi</span><h3>{parcel.trackingNumber}</h3></div>
        <Badge tone={status('parcel', parcel.status).tone}>{status('parcel', parcel.status).label}</Badge>
      </Card>}
      <Card className="stack">
        <h3>{user.display_name || 'Mon profil'}</h3>
        {!user.needs_profile && <ProfileForm/>}
      </Card>
      {!user.needs_profile && <PrivacyCenter/>}
    </>}
    {/* Two different people reach this point. Somebody who only travels is
        offered the professional door, quietly. Somebody who already works here
        is offered the way into the workspace they actually hold : never a role
        switcher, and never an invitation to onboard a second time. */}
    {user && user.role !== 'passenger' && <Card className="stack">
      <SectionTitle icon={Store} title="Espace professionnel"/>
      <p className="small muted">{user.operator_name
        ? `Votre compte professionnel : ${user.operator_name}.`
        : 'Votre compte professionnel LeRoutier.'}</p>
      <button className="btn btn-primary" onClick={() => navigate(professionalWorkspace(user).to)}>
        {professionalWorkspace(user).label}</button>
    </Card>}
    {(!user || (user.role === 'passenger' && !user.needs_profile)) && <Card className="stack">
      <SectionTitle icon={Store} title="Vous travaillez dans le transport ?"/>
      <p className="small muted">LeRoutier accueille les chauffeurs indépendants et les compagnies de transport. Votre compte voyageur reste inchangé.</p>
      <button className="btn btn-soft" onClick={() => navigate('/professionnel')}>Espace professionnel</button>
    </Card>}
  </>;
}

// ── Operator onboarding ────────────────────────────────────────────────────

// ── Parcels ────────────────────────────────────────────────────────────────
const categories = ['documents', 'food', 'electronics', 'fragile', 'high_value', 'other'];
const categoryLabels = { documents: 'Documents', food: 'Denrées alimentaires', electronics: 'Électronique', fragile: 'Fragile', high_value: 'Valeur déclarée', other: 'Autre' };
// Public milestones, in the order a sender expects to see them.
const PARCEL_TIMELINE = [
  ['accepted', 'Accepté'], ['loaded', 'Chargé'], ['in_transit', 'En route'],
  ['arrived', 'Arrivé'], ['ready_for_pickup', 'Prêt à retirer'], ['collected', 'Retiré'],
];
const REACHED = { created: 0, accepted: 1, manifested: 1, loaded: 2, in_transit: 3, arrived: 4, ready_for_pickup: 5, collected: 6 };

function Steps({ current, labels }) {
  return <div className="steps">{labels.map((label, i) => <span key={label}>
    <span className={`step ${i === current ? 'active' : i < current ? 'done' : ''}`}>
      <span className="num">{i < current ? '✓' : i + 1}</span>{label}
    </span>{i < labels.length - 1 && <span className="sep"> · </span>}
  </span>)}</div>;
}

// A city picker over the canonical Benin geography (12 departments, 77
// communes), independent of transport routes. Picking a city shows whether a
// parcel service actually exists there today: geography availability and
// transport availability are deliberately not conflated.
function CityPicker({ label, selected, onPick, stops }) {
  const places = useApi('/places?type=commune');
  const departments = useApi('/places?type=department');
  const [query, setQuery] = useState('');
  const communes = (places.data || []).filter(p => !query.trim() ||
    foldText(`${p.name} ${p.normalized_name || ''}`).includes(foldText(query.trim())));
  const deptName = id => (departments.data || []).find(d => d.id === id)?.name || '';
  const byCity = new Map(stops.map(s => [foldText(s.city), s]));
  return <div className="stack">
    <label>{label}
      <input className="control" type="search" placeholder="Rechercher une ville…" value={query}
        onChange={e => setQuery(e.target.value)} aria-label={`Rechercher une ville pour ${label}`}/>
    </label>
    <select className="control" aria-label={label} value={selected?.place?.id || ''} onChange={e => {
      const place = (places.data || []).find(p => p.id === e.target.value);
      const stop = place ? byCity.get(foldText(place.name)) : null;
      onPick(place ? { place, stopId: stop?.stopId ?? null } : null);
    }}>
      <option value="">Choisir…</option>
      {communes.map(p => {
        const available = byCity.has(foldText(p.name));
        return <option key={p.id} value={p.id}>{p.name}{deptName(p.parent_id) ? ` (${deptName(p.parent_id)})` : ''}{available ? ' · service colis' : ''}</option>;
      })}
    </select>
    {places.loading && <p className="small muted" role="status">Chargement des villes…</p>}
    {selected && !selected.stopId && <p className="small muted" role="status">LeRoutier n’a pas encore de point colis publié dans cette ville.</p>}
    {selected?.stopId && <p className="small muted" role="status">Service colis disponible depuis {selected.place.name}.</p>}
    {!places.loading && !places.data?.length && <p className="small muted" role="status">Aucune ville disponible pour le moment.</p>}
  </div>;
}

export function Parcels() {
  const { user, request, online } = useSession();
  const routes = useApi(user?.is_demo ? '/routes?testMode=1' : '/routes'), mine = useApi(user ? '/me/parcels' : null);
  const stops = [...new Map((routes.data || []).flatMap(r=>r.stops || []).map(s=>[s.stop_id || s.id,s])).values()];
  const [originPick, setOriginPick] = useState(null), [destinationPick, setDestinationPick] = useState(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [senderName, setSenderName] = useState(user?.display_name || ''), [senderPhone, setSenderPhone] = useState(user?.phone || '');
  const [receiverName, setReceiverName] = useState(''), [receiverPhone, setReceiverPhone] = useState('');
  const [origin, setOrigin] = useState(''), [destination, setDestination] = useState(''), [category, setCategory] = useState('documents');
  const [weight, setWeight] = useState(''), [notes, setNotes] = useState('');
  // What the sender says the contents are worth. It already shaped the carrier
  // tariff server-side (parcel_rate_rules.declared_value_bp) but had no field
  // to arrive through, so it was always zero. It is also what a parcel cover is
  // priced and capped on, which is why it appears now.
  const [declaredValue, setDeclaredValue] = useState('');
  const declaredValueMinor = declaredValue ? Number(declaredValue) : 0;
  const [cover, setCover] = useState(null), [coverNotice, setCoverNotice] = useState('');
  const [label, setLabel] = useState(null), [showDocuments, setShowDocuments] = useState(false);
  const quoteUrl = origin && destination ? `/parcels/quote?originStopId=${origin}&destinationStopId=${destination}&category=${category}${weight ? `&weightG=${weight}` : ''}${declaredValueMinor ? `&declaredValueMinor=${declaredValueMinor}` : ''}` : null;
  const quoteApi = useApi(quoteUrl);
  const quote = quoteApi.data;

  async function create(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const parcel = await request('/parcels', { method: 'POST', key: 'parcel-' + crypto.randomUUID(), body: {
        senderName, senderPhone: senderPhone.trim(), receiverName, receiverPhone: receiverPhone.trim(),
        originStopId: origin, destinationStopId: destination, category, weightG: weight ? Number(weight) : undefined,
        ...(declaredValueMinor ? { declaredValueMinor } : {}), notes: notes.trim() || undefined } });
      // Same contract as the trip: the cover attaches to a parcel that now
      // exists, and failing to attach never costs the sender their shipment.
      if (cover) {
        try {
          await request(`/parcels/${parcel.id}/insurance`, { method: 'POST', key: 'cover-' + parcel.id,
            body: { productId: cover.productId, consentVersion: cover.consentVersion } });
        } catch {
          setCoverNotice('Votre envoi est enregistré. La demande d’assurance n’a pas pu être transmise : '
            + 'vous pourrez la refaire depuis le détail du colis.');
        }
      }
      mine.reload(); setStep(3);
      setLabel(await request(`/parcels/${parcel.id}/label`));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const canRoute = origin && destination && origin !== destination;
  const canPeople = receiverName.trim() && receiverPhone.trim() && senderName.trim() && senderPhone.trim();

  // No hero here. ParcelExperience (passenger-entry.jsx) already wraps this
  // screen in one — kicker, h1 and lead — and this card repeated all three,
  // giving the page two <h1>s whose text was the same sentence in two moods:
  // "Envoyer un colis entre les villes" above, "Envoyez un colis entre les
  // villes." 200px below. The shell's hero is the one that survives.
  return <>
    {error && <ErrorState title="Envoi impossible" text={error}/>}

    {label ? <Card className="card-success stack">
      <div className="between wrap"><h3>Colis enregistré</h3><Badge tone="success">{label.trackingNumber}</Badge></div>
      <div className="ticket-qr"><QRCodeSVG value={label.trackingUrl || label.token} size={180} marginSize={4}/>
        <span className="small muted">Présentez ce QR depuis votre téléphone au conducteur. Aucune impression n’est nécessaire.</span></div>
      <Card className="stack label-print">
        <strong>Référence courte : {label.trackingNumber}</strong>
        <span className="small muted">Si votre téléphone est indisponible, écrivez cette référence sur le colis.</span>
        <span className="small">{label.origin} → {label.destination} · {categoryLabels[label.category]}{label.receiver ? ` · destinataire ${label.receiver.initial}. · ${label.receiver.phone}` : ''}</span>
        <button type="button" className="btn btn-soft" onClick={() => setShowDocuments(true)}>Étiquette et reçu · PDF / impression</button>
        {showDocuments && <ParcelDocuments parcel={label} onClose={() => setShowDocuments(false)}/>}
        <p className="small">{label.parties?.sender?.name} → {label.parties?.receiver?.name}</p>
        <p className="small">{status('parcel', label.status).label} · Impression facultative</p>
      </Card>
      <p className="small">Communiquez le numéro <strong>{label.trackingNumber}</strong> au destinataire pour le suivi public. Le QR du colis ne prouve jamais son identité.</p>
      <div className="controls"><button className="btn btn-soft" onClick={() => { setLabel(null); setStep(0); }}>Envoyer un autre colis</button></div>
    </Card> : <Card className="stack">
      <Steps current={step} labels={['Trajet', 'Personnes', 'Colis & prix']}/>
      {!user && <p className="small muted" role="status">Connectez-vous pour créer un envoi.</p>}
      {user && <form className="stack" onSubmit={create}>
        {step === 0 && <>
          <CityPicker label="Ville de départ" stops={stops} selected={originPick}
            onPick={p => { setOriginPick(p); setOrigin(p?.stopId || ''); }}/>
          <CityPicker label="Ville d’arrivée" stops={stops} selected={destinationPick}
            onPick={p => { setDestinationPick(p); setDestination(p?.stopId || ''); }}/>
          {origin && destination && origin === destination && <p className="small muted" role="status">Choisissez deux villes différentes.</p>}
          <button type="button" className="btn btn-primary" disabled={!canRoute} onClick={() => setStep(1)}>Continuer</button>
        </>}
        {step === 1 && <>
          <label>Votre nom<input className="control" required minLength={2} maxLength={100} value={senderName} onChange={e => setSenderName(e.target.value)}/></label>
          <label>Votre téléphone<input className="control" type="tel" required value={senderPhone} onChange={e => setSenderPhone(e.target.value)}/></label>
          <label>Nom du destinataire<input className="control" required minLength={2} maxLength={100} value={receiverName} onChange={e => setReceiverName(e.target.value)}/></label>
          <label>Téléphone du destinataire<input className="control" type="tel" required value={receiverPhone} onChange={e => setReceiverPhone(e.target.value)}/></label>
          <p className="small muted">Partagez la référence avec le destinataire. Les alertes utilisent les canaux disponibles ; le retrait nécessite un code distinct.</p>
          <div className="controls">
            <button type="button" className="btn btn-primary" disabled={!canPeople} onClick={() => setStep(2)}>Continuer</button>
            <button type="button" className="btn btn-soft" onClick={() => setStep(0)}>Retour</button>
          </div>
        </>}
        {step === 2 && <>
          <label>Contenu<select className="control" value={category} onChange={e => setCategory(e.target.value)}>
            {categories.map(c => <option key={c} value={c}>{categoryLabels[c]}</option>)}</select></label>
          <label>Poids approximatif (grammes)<input className="control" type="number" min={1} step={1} placeholder="Facultatif" value={weight} onChange={e => setWeight(e.target.value)}/></label>
          <label>Valeur déclarée du contenu (FCFA)<input className="control" type="number" min={0} step={100} placeholder="Facultatif" value={declaredValue} onChange={e => setDeclaredValue(e.target.value)}/></label>
          <p className="small muted">La valeur déclarée peut modifier le tarif du transporteur et détermine le montant assurable.</p>
          <label>Précisions pour l’équipage (facultatif)<input className="control" maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)}/></label>
          {quote && <div className="summary">
            <div className="row"><span>Prix</span><span>{fcfa(quote.amountMinor)}</span></div>
            <div className="row"><span>Transporteur</span><span>{quote.operatorName}</span></div>
          </div>}
          {quoteUrl && quoteApi.error && <p className="small muted" role="alert">Le tarif n’a pas pu être calculé pour cet envoi.</p>}
          <InsuranceOffer scope="parcel" declaredValueMinor={declaredValueMinor} chosen={cover} onChoose={setCover} disabled={busy}/>
          {coverNotice && <p className="notice" role="status">{coverNotice}</p>}
          <div className="controls">
            <button className="btn btn-primary" disabled={busy || !online || !quote}>{busy ? 'Enregistrement…' : 'Confirmer l’envoi'}</button>
            <button type="button" className="btn btn-soft" onClick={() => setStep(1)}>Retour</button>
          </div>
          <p className="small muted">Le tarif est fixé par le transporteur : aucun prix n’est inventé.</p>
        </>}
      </form>}
    </Card>}

    <SectionTitle title="Mes envois"/>
    {!user ? null : mine.loading ? <SkeletonCards count={2} lines={2}/>
      : mine.error ? <ErrorState text="Impossible de charger vos envois." onRetry={mine.reload}/>
        : !mine.data?.length ? <ApiState resource={mine} emptyTitle="Aucun envoi" empty="Vos colis apparaîtront ici."/>
          : mine.data.map(p => <Card key={p.id} className="stack">
            <div className="between wrap">
              <div><h3>{p.trackingNumber}</h3>
                <span className="small muted">{categoryLabels[p.category]} · {fcfa(p.priceMinor)} · {dayShort(p.createdAt)}</span></div>
              <Badge tone={status('parcel', p.status).tone}>{status('parcel', p.status).label}</Badge>
              <button className="btn btn-soft" disabled={busy || !online} onClick={async()=>{
                setBusy(true);setError('');
                try{setLabel(await request(`/parcels/${p.id}/label`));window.scrollTo({top:0,behavior:'smooth'});}
                catch(e){setError(e.message);}finally{setBusy(false);}
              }}>Afficher le reçu et le QR</button>
            </div>
            <InsurancePolicy scope="parcel" subjectId={p.id}/>
          </Card>)}

    {/* Tracking sits with sending: it is the same errand for the same person. */}
    <ParcelTracking/>
  </>;
}

// Public parcel tracking: a modern logistics timeline, no custody internals.
export function ParcelTracking() {
  const { request } = useSession();
  const [params] = useSearchParams();
  const [input, setInput] = useState(() => params.get('ref') || ''), [tracking, setTracking] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function track(e, scanned) {
    e?.preventDefault(); setError(''); setTracking(null); setBusy(true);
    const value = scanned || input;
    if (scanned) setInput(scanned);
    try { setTracking(await request(`/public/parcel-tracking/${encodeURIComponent(value.trim().toUpperCase())}`)); }
    catch (e) { setError(e.status === 404 ? 'Ce numéro de suivi est introuvable. Vérifiez les caractères saisis.' : 'Le suivi est momentanément indisponible.'); }
    finally { setBusy(false); }
  }
  const reached = tracking ? (REACHED[tracking.status] ?? 0) : 0;
  return <>
    <SectionTitle icon={Package} title="Suivre un colis"/>
    <Card className="stack">
      <form className="stack" onSubmit={track}>
        <QrCapture label="Scanner le QR du colis"
          rejectText="Ce QR ne contient pas de référence de suivi LeRoutier."
          accept={value => value.match(/^(?:https:\/\/leroutier\.app\/parcels\/track\?ref=)?(LRP-[0-9A-F]{8})$/i)?.[1]?.toUpperCase() ?? null}
          onRead={reference => track(null, reference)}/>
        <label>Numéro de suivi<input className="control" placeholder="LRP-XXXXXXXX" aria-label="Numéro de suivi" value={input} onChange={e => setInput(e.target.value)}/></label>
        <button className="btn btn-primary" disabled={!input.trim() || busy}>{busy ? 'Recherche…' : 'Suivre mon colis'}</button>
      </form>
      {error && <p className="small muted" role="alert">{error}</p>}
    </Card>
    {tracking && <Card className="stack">
      <div className="between wrap">
        <div><h2>{tracking.trackingNumber}</h2>
          <span className="small muted">{tracking.origin.city} → {tracking.destination.city}</span></div>
        <Badge tone={status('parcel', tracking.status).tone}>{status('parcel', tracking.status).label}</Badge>
      </div>
      {tracking.eta && <p className="small">Arrivée estimée : {dateTime(tracking.eta)}</p>}
      <div className="stack">
        {PARCEL_TIMELINE.map(([key, label], i) => <div key={key} className={`journey-step ${i < reached ? 'done' : ''}`}>
          <span aria-hidden="true">{i < reached ? '✓' : '○'}</span>
          <strong className="small">{label}</strong>
          {i === reached - 1 && tracking.lastMilestone && <span className="small muted">{dateTime(tracking.lastMilestone.at)}</span>}
        </div>)}
      </div>
      {tracking.pickupReady && <div className="notice">Votre colis est prêt. Un code de retrait vous sera demandé à la remise.</div>}
    </Card>}
  </>;
}
