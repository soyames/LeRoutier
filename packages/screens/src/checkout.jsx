import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi, useSession } from '@leroutier/config/client';
import { priceWithServiceFee } from '@leroutier/domain';
import { Card, Badge, SectionTitle, ErrorState, BrandLoader, PHONE_COUNTRIES, resolvePhoneCountry, composePhone } from '@leroutier/ui';
import { fcfa, time, dayLong } from '@leroutier/ui';
import { ArrowLeft, CreditCard, Lock, Users } from 'lucide-react';
import { TestBadge, ModeTestBanner } from './journey-results.jsx';
import { InsuranceOffer } from './insurance.jsx';

// The checkout: no account is required at any point.
//
//   choose() → /checkout (anonymous, fare visible)
//   → quantity, and a name and phone to reach the buyer on
//   → hold (one purchase, N seats) → payment (FedaPay, or the simulated TEST
//     path) → confirmation → the tickets
//
// An ACCOUNT is offered afterwards, on the tickets, as a way to keep them. It
// is never a toll gate on the way to one, which is what it used to be: this
// screen stopped at "Continuer vers le paiement" and demanded a sign-in.
//
// A SIGNED-IN passenger still buys as themselves, and their tickets land on
// their account. An account that has never bought anything is not a passenger
// account yet, so it buys as a guest and adopts the purchase afterwards — the
// one path that turns it into a passenger account.
//
// The selected offer lives in sessionStorage (no secrets, no payment data) and
// survives a page refresh. The guest access token does NOT live here: it is
// written to localStorage by the session provider, because it has to outlive
// the tab that made the purchase.

const INTENT = 'leroutier:checkout-intent';
const readIntent = () => { try { return JSON.parse(window.sessionStorage.getItem(INTENT) || 'null'); } catch { return null; } };
const clearIntent = () => { try { window.sessionStorage.removeItem(INTENT); } catch { /* private mode */ } };

export function rememberCheckout(intent) {
  const { routeGeometry, livePosition, ...option } = intent.option;
  void routeGeometry; void livePosition;
  try { window.sessionStorage.setItem(INTENT, JSON.stringify({ ...intent, option, holdKey: intent.holdKey ?? crypto.randomUUID(), payKey: intent.payKey ?? crypto.randomUUID() })); } catch { /* private mode */ }
}

const mins = seconds => (Number.isFinite(seconds) ? `${Math.round(seconds / 60)} min` : null);
const km = metres => (Number.isFinite(metres) ? `${Math.round(metres / 1000 * 10) / 10} km` : null);
const MAX_TICKETS = 10;

/** The seat a purchase is anchored to: the first of its party. */
const firstBookingId = purchase => purchase?.bookings?.[0]?.id ?? purchase?.id ?? null;

function JourneySummary({ intent, perPassenger, quantity, seatsLeft }) {
  const option = intent.option;
  const plural = quantity > 1;
  return <div className="checkout-summary stack">
    <div className="between wrap">
      <div><h2>Votre trajet</h2>
        <span className="small muted">{dayLong(option.departureAt)} · {time(option.departureAt)}</span></div>
      {option.isTest ? <TestBadge/> : <Badge tone="neutral"><Lock size={12}/>Prix sélectionné</Badge>}
    </div>
    <div className="offer-journey">
      <div className="offer-line"><span className="offer-dot start"/>
        <div><strong>{intent.originLabel ?? option.pickupStop.city}</strong>
          {option.firstMile && <span className="small muted"> · Premier kilomètre : {mins(option.firstMile.durationS)} · {km(option.firstMile.distanceM)}</span>}</div></div>
      <div className="offer-rail"/>
      <div className="offer-line"><span className="offer-dot"/>
        <div><strong>{option.pickupStop.name}</strong><span className="small muted"> · prise en charge</span></div></div>
      <div className="offer-rail"/>
      <div className="offer-line"><span className="offer-dot"/>
        <div><strong>Transport LeRoutier · {option.operatorName}</strong>
          <span className="small muted">{time(option.departureAt)} → {time(option.intercity.etaAt)}
            {option.vehicle?.model ? ` · ${option.vehicle.model}` : ''}</span></div></div>
      <div className="offer-rail"/>
      <div className="offer-line"><span className="offer-dot"/>
        <div><strong>{option.dropoffStop.name}</strong><span className="small muted"> · descente</span></div></div>
      {option.lastMile && <><div className="offer-rail"/>
        <div className="offer-line"><span className="offer-dot end"/>
          <div><strong>{intent.destinationLabel ?? option.dropoffStop.city}</strong>
            <span className="small muted"> · Dernier kilomètre : {mins(option.lastMile.durationS)} · {km(option.lastMile.distanceM)}</span></div></div></>}
    </div>
    <p className="small muted">{seatsLeft} place{seatsLeft > 1 ? 's' : ''} disponible{seatsLeft > 1 ? 's' : ''} pour cette portion · Arrivée estimée : {option.etaAt ? time(option.etaAt) : 'Indisponible'}</p>
    {option.waitingS > 0 && <p className="small muted">Attente à la prise en charge : {mins(option.waitingS)}</p>}
    {/* The fare per passenger and the total for the party, both from the
        server's quote, both before payment. */}
    <div className="between wrap checkout-line">
      <span>{fcfa(perPassenger)} par voyageur</span>
      {plural && <span className="muted">× {quantity} voyageurs</span>}
    </div>
    <div className="between wrap checkout-total">
      <span>Total · tarif + frais LeRoutier (2 %)</span>
      <span className="trip-price">{fcfa(priceWithServiceFee(perPassenger * quantity).totalMinor)}</span>
    </div>
  </div>;
}

// Choosing a seat, before signing in.
//
// Availability is per leg, so a seat carrying somebody on an earlier part of
// the route is genuinely free here and is offered as such. Skipping is the
// default: a passenger who does not care gets the first free seat, exactly as
// before, and is never blocked by a grid they did not ask for.
//
// One seat is offered at a time because one passenger is choosing. For a party
// the coach assigns the seats itself — picking three neighbours off a phone
// screen, for people who are not in the room, is a puzzle nobody asked for, and
// the seats are printed on the tickets either way.
function SeatPicker({ option, value, onChange }) {
  const plan = useApi(`/services/${option.serviceId}/seats?origin=${option.originSequence}&destination=${option.destinationSequence}`);
  if (plan.loading || plan.error || !plan.data) return null;
  const seats = plan.data.seats ?? [];
  const free = seats.filter(s => s.available).length;
  if (!free) return null;
  return <Card className="stack">
    <div className="between wrap">
      <div><strong>Choisir votre siège</strong>
        <p className="small muted">Facultatif. Sans choix, nous vous attribuons une place libre.</p></div>
      <Badge tone={free > 2 ? 'success' : 'warning'}>{free} libre{free > 1 ? 's' : ''}</Badge>
    </div>
    <div className="seat-grid" role="group" aria-label="Sièges disponibles">
      {seats.map(seat => <button key={seat.seatNumber} type="button"
        className={`seat ${seat.available ? '' : 'taken'} ${value === seat.seatNumber ? 'chosen' : ''} ${seat.freedForThisLeg ? 'freed' : ''}`}
        disabled={!seat.available} aria-pressed={value === seat.seatNumber}
        aria-label={`Siège ${seat.seatNumber}${seat.available ? (seat.freedForThisLeg ? ', libre à partir de votre montée' : ', libre') : ', occupé'}`}
        onClick={() => onChange(value === seat.seatNumber ? null : seat.seatNumber)}>{seat.seatNumber}</button>)}
    </div>
    {seats.some(s => s.freedForThisLeg) && <p className="small muted">
      Les sièges marqués se libèrent à votre arrêt de montée : ils sont occupés plus tôt sur la ligne, pas sur la portion que vous réservez.</p>}
    {value && <p className="small" role="status">Siège {value} sélectionné.</p>}
  </Card>;
}

/**
 * How many tickets, with quick choices and a number for anything else.
 *
 * The ceiling is the smaller of the product's ten and what the coach still has,
 * so a quantity that cannot be sold is never offered in the first place.
 */
function QuantityPicker({ quantity, onChange, seatsLeft }) {
  const max = Math.max(1, Math.min(MAX_TICKETS, seatsLeft));
  const clamp = value => { const n = Number.parseInt(value, 10); return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : 1; };
  return <Card className="stack">
    <div className="between wrap">
      <div><strong>Combien de billets ?</strong>
        <p className="small muted">Un siège et un billet par voyageur, payés en une seule fois.</p></div>
      <Badge tone={seatsLeft > 3 ? 'success' : 'warning'}>{seatsLeft} place{seatsLeft > 1 ? 's' : ''}</Badge>
    </div>
    <div className="qty-row" role="group" aria-label="Nombre de billets">
      {/* Each chip names itself in words, so "3" is never read out — or looked
          up — as a seat number the coach happens to be showing. */}
      {[1, 2, 3].map(n => <button key={n} type="button" className={`qty ${quantity === n ? 'chosen' : ''}`}
        aria-label={`${n} billet${n > 1 ? 's' : ''}`} aria-pressed={quantity === n}
        disabled={n > max} onClick={() => onChange(n)}>{n}</button>)}
    </div>
    <label className="field">Autre nombre (1 à {max})
      <input className="control" type="number" inputMode="numeric" min={1} max={max}
        value={quantity} aria-label="Autre nombre de billets"
        onChange={e => onChange(clamp(e.target.value))}/>
    </label>
  </Card>;
}

export function Checkout() {
  const navigate = useNavigate();
  const [intent] = useState(readIntent);
  useEffect(() => { if (!intent?.option) navigate('/trips', { replace: true }); }, [intent, navigate]);
  return intent?.option ? <CheckoutFlow intent={intent}/> : null;
}

function CheckoutFlow({ intent }) {
  const navigate = useNavigate();
  const { user, request, online, guestToken, rememberGuest } = useSession();
  const option = intent.option;
  const [step, setStep] = useState('review');
  const [seat, setSeat] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [name, setName] = useState(user?.display_name ?? '');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState(() => resolvePhoneCountry(option?.pickupStop?.countryCode));
  // The server's quote, not the offer's. The offer's fare travelled through a
  // search result; this one comes from the availability the booking is made
  // against, and it is the one both sides compare.
  const availability = useApi(`/services/${option.serviceId}/availability?origin=${option.originSequence}&destination=${option.destinationSequence}`);
  const [fareNotice, setFareNotice] = useState('');
  const [cover, setCover] = useState(null);
  const [coverNotice, setCoverNotice] = useState('');
  const [error, setError] = useState('');
  const keys = useRef(new Map([['hold', intent.holdKey ?? crypto.randomUUID()], ['pay', intent.payKey ?? crypto.randomUUID()]]));
  const running = useRef(false);
  // The token this purchase is being made with: the one already in this browser,
  // or the one the hold hands back. Null means "no identity", which the API
  // reads as a guest buyer — deliberately not the session's token, or a
  // signed-in account that cannot yet buy would have the purchase attributed to
  // it anyway.
  //
  // A REF, AND NOT A PIECE OF STATE, because the hold MINTS this token and the
  // payment that follows belongs to the same click: a state update has not
  // re-rendered by the time the next request is built, so a payment reading
  // state would go out carrying the null this browser held a moment earlier.
  // That was a real refusal — a guest's first purchase held its seats and was
  // then told to sign in to pay for them, with the token it had just been given
  // sitting unused. Nothing renders this value, so nothing needs to re-render
  // when it arrives; `rememberGuest` already updates the session, which does
  // re-render every screen that shows a guest their tickets.
  const buyTokenRef = useRef(guestToken ?? null);
  const buyingAsSelf = Boolean(user?.passenger_activated && !user?.needs_profile);
  // A function rather than a value, so every request reads the token that is
  // true when IT is built — including the one built microseconds after the hold
  // issued it.
  const authOptions = () => (buyingAsSelf ? {} : { token: buyTokenRef.current });

  const backToResults = () => {
    clearIntent();
    const params = new URLSearchParams({ date: intent.search?.date ?? '' });
    params.set('from', intent.search?.from ?? '');
    params.set('to', intent.search?.to ?? '');
    if (intent.search?.testMode) params.set('testMode', '1');
    navigate(`/trips?${params}`);
  };

  const perPassenger = availability.data?.fare?.amountMinor ?? option.fare.amountMinor;
  const seatsLeft = availability.data?.available ?? option.available;
  const fareTotal = perPassenger * quantity;
  const pricing = priceWithServiceFee(fareTotal);
  const total = pricing.totalMinor;
  const soldOut = seatsLeft === 0;
  const contactIncomplete = !buyingAsSelf && (name.trim().length < 2 || phone.replace(/[^0-9]/g, '').length < 6);

  async function holdPurchase() {
    setError(''); setStep('paying');
    const key = keys.current.get('hold') ?? crypto.randomUUID();
    keys.current.set('hold', key);
    try {
      const body = { serviceId: option.serviceId, origin: option.originSequence, destination: option.destinationSequence,
        quantity,
        // The fare the customer is looking at is asserted only when there is a
        // server quote behind it to have shown them. Without one — the quote
        // failed to load — the hold carries the server's own price and the
        // screen renders it before payment, rather than being refused against a
        // number that could never be refreshed.
        ...(availability.data ? { expectedAmountMinor: total } : {}),
        ...(quantity === 1 && seat ? { seatNumber: seat } : {}),
        ...(buyingAsSelf ? {} : { passengerName: name.trim(), passengerPhone: composePhone(country, phone) }) };
      const held = await request('/bookings', { method: 'POST', key, body, ...authOptions() });
      // The purchase mints an access token the first time this browser buys
      // without an account. It is kept so the tickets survive the payment
      // redirect and the tab being closed.
      if (held.guestToken) { rememberGuest(held.guestToken); buyTokenRef.current = held.guestToken; }
      // The add-on attaches to the booking that now exists. Deliberately
      // outside the try that governs the booking: an insurance request that
      // fails must never cost somebody their seat. It is reported as itself
      // and the journey continues to payment either way.
      if (cover) {
        try {
          await request(`/bookings/${firstBookingId(held)}/insurance`, { method: 'POST', key: 'cover-' + held.id,
            body: { productId: cover.productId, consentVersion: cover.consentVersion }, ...authOptions() });
        } catch {
          setCoverNotice('Votre réservation est enregistrée. La demande d’assurance n’a pas pu être envoyée : '
            + 'vous pourrez la refaire depuis votre billet.');
        }
      }
      return held;
    } catch (e) {
      // A fare that moved between the quote and the hold is stated and has to be
      // accepted. Nothing is held at a price the customer never saw: the server
      // refuses the hold outright rather than taking the seats and asking later.
      if (e.code === 'FARE_CHANGED') {
        setStep('quote');
        // The quote is re-read. If somebody accepts before the new figures land,
        // the server refuses again with the same reason — a stale client is
        // never able to pay a price that has moved.
        availability.reload();
        setFareNotice('Le tarif a changé depuis votre recherche. Vérifiez le nouveau prix avant de payer. Aucun paiement n’a été effectué.');
        return null;
      }
      // A seat that went while the passenger was deciding is a different
      // problem from a full coach, and only one of them they can fix here.
      if (e.code === 'SEAT_TAKEN') { setSeat(null); setError('Ce siège vient d’être pris. Choisissez-en un autre.'); }
      else if (e.code === 'SOLD_OUT' || e.code === 'SERVICE_UNAVAILABLE') {
        setError(e.message || 'Ce trajet n’est plus disponible. Retournez aux résultats pour choisir un autre départ.');
        availability.reload();
      } else if (e.code === 'PASSENGER_NOT_ACTIVATED' || e.code === 'PROFILE_REQUIRED') {
        // The account asked to buy as itself and cannot yet. Buying as a guest is
        // the way forward, and it is the way the purchase becomes adoptable.
        setError('Achetez sans compte, puis rattachez ce billet : votre compte voyageur s’activera. Rechargez la page pour repartir en invité.');
      } else setError(e.message);
      setStep('review');
      return null;
    }
  }

  async function pay(held) {
    setError('');
    const key = keys.current.get('pay') ?? crypto.randomUUID();
    keys.current.set('pay', key);
    const anchor = firstBookingId(held);
    // TEST bookings take the simulated path: no provider, no real money,
    // and the same confirmation flow as a real payment.
    if (option.isTest) {
      try {
        await request(`/bookings/${held.id}/payments/test`, { method: 'POST', key, body: {}, ...authOptions() });
        clearIntent();
        navigate(`/tickets/${anchor}`);
      } catch (e) { setError(e.message); setStep('review'); }
      return;
    }
    try {
      const payment = await request(`/bookings/${held.id}/payment-intents`, { method: 'POST', key: 'pay-' + held.id, body: {}, ...authOptions() });
      if (payment.checkoutUrl) window.location.assign(payment.checkoutUrl);
      else { setError('Le lien de paiement est indisponible. Réessayez dans un instant.'); setStep('review'); }
    } catch (e) {
      setError(e.code === 'PAYMENT_UNAVAILABLE' ? 'Le paiement en ligne est momentanément indisponible.' : e.message);
      setStep('review');
    }
  }

  async function continueToPayment() {
    if (running.current) return;
    running.current = true;
    try { const held = await holdPurchase(); if (held) await pay(held); }
    finally { running.current = false; }
  }

  return <div className="stack">
    <SectionTitle icon={CreditCard} title="Récapitulatif avant paiement"/>
    <Card className="stack">
      {!online && <p role="status">Hors ligne : les actions nécessitent une connexion.</p>}
      <JourneySummary intent={intent} perPassenger={perPassenger} quantity={quantity} seatsLeft={seatsLeft}/>
      {option.isTest && <ModeTestBanner/>}
      {fareNotice && <p className="notice" role="status">{fareNotice}</p>}
      <p className="small muted">Aucun compte n’est nécessaire, ni pour réserver ni pour voyager. Vos billets vous sont remis à la fin du paiement.</p>

      {step !== 'paying' && !soldOut && <QuantityPicker quantity={quantity} onChange={setQuantity} seatsLeft={seatsLeft}/>}

      {/* Only a visitor — or an account that cannot yet buy as itself — is asked
          for contact details. A returning passenger already gave them. */}
      {step !== 'paying' && !soldOut && !buyingAsSelf && <Card className="stack">
        <div><strong>Vos coordonnées</strong>
          <p className="small muted">Pour vous joindre au sujet de ce départ. Elles servent aussi à retrouver vos billets.</p></div>
        <label className="field">Nom et prénom du voyageur principal
          <input className="control" value={name} onChange={e => setName(e.target.value)} autoComplete="name" maxLength={100}/>
        </label>
        <label className="field">Téléphone
          <div className="phone-field">
            <select className="control" value={country} onChange={e => setCountry(e.target.value)} aria-label="Pays de l’indicatif">
              {PHONE_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name} (+{c.dial})</option>)}
            </select>
            <input className="control" type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)}
              autoComplete="tel" maxLength={25} placeholder="97 00 00 42" aria-label="Numéro de téléphone"/>
          </div>
        </label>
      </Card>}

      {step === 'review' && !soldOut && quantity === 1 && <SeatPicker option={option} value={seat} onChange={setSeat}/>}
      {step === 'review' && quantity > 1 && <p className="small muted" role="status">
        Nous attribuons {quantity} places libres. Chaque voyageur reçoit son propre billet avec son siège.</p>}
      {step === 'review' && <div className="summary" aria-label="Détail du prix">
        <div className="row"><span>Tarif fixé par le transporteur · {quantity} voyageur{quantity>1?'s':''}</span><span>{fcfa(fareTotal)}</span></div>
        <div className="row"><span>Frais de service LeRoutier (2 %)</span><span>{fcfa(pricing.serviceFeeMinor)}</span></div>
        <div className="row"><strong>Total à payer</strong><strong>{fcfa(total)}</strong></div>
        <p className="small muted">Les éventuels frais du prestataire de paiement sont affichés séparément par celui-ci avant validation.</p>
      </div>}
      {/* Offered while the fare is still on screen, so it is a decision rather
          than a surprise after payment. Renders nothing at all when no partner
          is active, which is the state until one signs. */}
      {step === 'review' && !soldOut && !option.isTest
        && <InsuranceOffer scope="trip" chosen={cover} onChoose={setCover}/>}
      {coverNotice && <p className="notice" role="status">{coverNotice}</p>}

      {step === 'review' && <div className="controls">
        <button className="btn btn-soft" onClick={backToResults}><ArrowLeft size={15}/>Retour aux résultats</button>
        <button className="btn btn-primary" disabled={soldOut || !online || contactIncomplete} onClick={continueToPayment}>
          <Lock size={15}/>{quantity > 1 ? `Payer ${quantity} billets` : 'Continuer vers le paiement'}</button>
      </div>}
      {step === 'review' && !buyingAsSelf && contactIncomplete && !soldOut && <p className="small muted" role="status">
        Indiquez le nom du voyageur principal et un numéro de téléphone joignable pour continuer.</p>}

      {step === 'quote' && <div className="controls">
        <button className="btn btn-soft" onClick={backToResults}>Retour aux résultats</button>
        <button className="btn btn-primary" disabled={!online || soldOut} onClick={continueToPayment}>
          <Users size={15}/>Accepter {fcfa(total)} et payer</button>
      </div>}
      {step === 'paying' && <BrandLoader label="Création de votre réservation…"/>}
      {error && <ErrorState title="Paiement impossible" text={error}/>}
    </Card>
  </div>;
}
