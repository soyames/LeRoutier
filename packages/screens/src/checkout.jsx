import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '@leroutier/config/client';
import { Card, Badge, SectionTitle, ProfileForm, ErrorState, SessionPanel } from '@leroutier/ui';
import { fcfa, time, dayLong } from '@leroutier/ui';
import { ArrowLeft, CreditCard, Lock } from 'lucide-react';
import { TestBadge, ModeTestBanner } from './journey-results.jsx';

// The checkout: anonymous review first, authentication ONLY on
// "Continuer vers le paiement".
//
//   choose() → /checkout (anonymous, fare visible)
//   → Continuer vers le paiement → login/register (right here)
//   → profile if missing (inline)
//   → hold → payment (FedaPay, or the simulated TEST path) → confirmation
//
// The selected offer lives in sessionStorage (no secrets, no payment data)
// and survives the Google/email round trip and page refreshes.

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

function JourneySummary({ intent, fare }) {
  const option = intent.option;
  return <div className="checkout-summary stack">
    <div className="between wrap">
      <div><h2>Votre trajet</h2>
        <span className="small muted">{dayLong(option.departureAt)} · {time(option.departureAt)}</span></div>
      {option.isTest ? <TestBadge/> : <Badge tone="neutral"><Lock size={12}/>Prix s?lectionn?</Badge>}
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
    <p className="small muted">{option.available} place{option.available > 1 ? 's' : ''} disponible{option.available > 1 ? 's' : ''} ? Arriv?e estim?e : {option.etaAt ? time(option.etaAt) : 'Indisponible'}</p>
    {option.waitingS > 0 && <p className="small muted">Attente ? la prise en charge : {mins(option.waitingS)}</p>}
    <div className="between wrap checkout-total">
      <span>Prix total</span>
      <span className="trip-price">{fcfa(fare ?? option.fare.amountMinor)}</span>
    </div>
  </div>;
}

export function Checkout() {
  const navigate = useNavigate();
  const [intent] = useState(readIntent);
  useEffect(() => { if (!intent?.option) navigate('/trips', { replace: true }); }, [intent, navigate]);
  return intent?.option ? <CheckoutFlow intent={intent}/> : null;
}

function CheckoutFlow({ intent }) {
  const navigate = useNavigate();
  const { user, request, online } = useSession();
  const [step, setStep] = useState(intent.paymentRequested ? 'auth' : 'review');
  const [error, setError] = useState('');
  const [fare, setFare] = useState(null);
  const [booking, setBooking] = useState(null);
  const keys = useRef(new Map([['hold', intent.holdKey ?? crypto.randomUUID()], ['pay', intent.payKey ?? crypto.randomUUID()]]));
  const running = useRef(false);
  const option = intent.option;
  const backToResults = () => {
    clearIntent();
    const params = new URLSearchParams({ date: intent.search?.date ?? '' });
    params.set('from', intent.search?.from ?? '');
    params.set('to', intent.search?.to ?? '');
    if (intent.search?.testMode) params.set('testMode', '1');
    navigate(`/trips?${params}`);
  };

  async function holdBooking() {
    setError(''); setStep('paying');
    const key = keys.current.get('hold') ?? crypto.randomUUID();
    keys.current.set('hold', key);
    try {
      const b = await request('/bookings', { method: 'POST', key, body: { serviceId: option.serviceId, origin: option.originSequence, destination: option.destinationSequence } });
      setBooking(b);
      // Fare stability: the hold's amount is authoritative. A changed amount
      // is stated, never silently applied.
      if (b.amount_minor !== option.fare.amountMinor) {
        setFare(b.amount_minor); setStep('quote'); return null;
      }
      return b;
    } catch (e) {
      setError(e.code === 'SOLD_OUT' || e.code === 'SERVICE_UNAVAILABLE'
        ? 'Ce trajet n’est plus disponible. Retournez aux résultats pour choisir un autre départ.'
        : e.message);
      setStep('review');
      return null;
    }
  }

  async function pay(b) {
    setError('');
    // TEST bookings take the simulated path: no provider, no real money,
    // and the same confirmation flow as a real payment.
    if (option.isTest) {
      const key = keys.current.get('pay') ?? crypto.randomUUID();
      keys.current.set('pay', key);
      try {
        await request(`/bookings/${b.id}/payments/test`, { method: 'POST', key, body: {} });
        const confirmed = { id: b.id }; // The TEST endpoint confirms atomically with payment.
        clearIntent();
        navigate(`/tickets/${confirmed.id}`);
      } catch (e) { setError(e.message); setStep('review'); }
      return;
    }
    try {
      const payment = await request(`/bookings/${b.id}/payment-intents`, { method: 'POST', key: 'pay-' + b.id, body: {} });
      if (payment.checkoutUrl) window.location.assign(payment.checkoutUrl);
      else { setError('Le lien de paiement est indisponible. Réessayez dans un instant.'); setStep('review'); }
    } catch (e) {
      setError(e.code === 'PAYMENT_UNAVAILABLE' ? 'Le paiement en ligne est momentanément indisponible.' : e.message);
      setStep('review');
    }
  }

  // The one authentication gate: continuing to payment. After the session
  // arrives (Google, email or registration — all through the same panel),
  // the profile step completes and the booking is created automatically.
  async function continueToPayment() {
    if (running.current) return;
    rememberCheckout({ ...intent, paymentRequested: true, holdKey: keys.current.get('hold'), payKey: keys.current.get('pay') });
    if (!user || user.needs_profile) { setStep('auth'); return; }
    running.current = true;
    try { const b = await holdBooking(); if (b) await pay(b); }
    finally { running.current = false; }
  }
  useEffect(() => {
    if (step !== 'auth' || !user || user.needs_profile) return;
    const timer = setTimeout(() => { void continueToPayment(); }, 0);
    return () => clearTimeout(timer);
    // The session/profile change resumes the action the passenger requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, step]);

  const soldOut = option.available === 0;
  return <div className="stack">
    <SectionTitle icon={CreditCard} title="Récapitulatif avant paiement"/>
    <Card className="stack">
      {!online && <p role="status">Hors ligne : les actions nécessitent une connexion.</p>}
      <JourneySummary intent={intent} fare={fare ?? (booking?.amount_minor ?? null)}/>
      {option.isTest && <ModeTestBanner/>}
      {/* A changed fare is stated plainly, never silently applied. */}
      {fare !== null && fare !== option.fare.amountMinor && <p className="notice" role="status">
        Le tarif a changé. Vérifiez le nouveau prix avant de poursuivre. Aucun paiement n’a été effectué.</p>}
      <p className="small muted">Aucun compte n’est nécessaire pour consulter ce récapitulatif. La connexion n’est demandée qu’au paiement.</p>

      {step === 'review' && <div className="controls">
        <button className="btn btn-soft" onClick={backToResults}><ArrowLeft size={15}/>Retour aux résultats</button>
        <button className="btn btn-primary" disabled={soldOut || !online} onClick={continueToPayment}>
          <Lock size={15}/>Continuer vers le paiement</button>
      </div>}

      {step === 'auth' && !user && <>
        <SectionTitle title="Connectez-vous pour payer"/>
        <p className="small muted">Votre trajet est conservé : vous reviendrez exactement ici après la connexion.</p>
        {/* The one authentication gate: Google, e-mail or account creation,
            all returning to this checkout. */}
        <SessionPanel/>
      </>}
      {step === 'auth' && user?.needs_profile && <Card className="stack">
        <strong>Complétez votre profil</strong>
        <p className="small muted">Nom complet et téléphone suffisent pour voyager. Vous reprendrez le paiement automatiquement.</p>
        <ProfileForm/>
      </Card>}
      {step === 'quote' && <div className="controls">
        <button className="btn btn-soft" onClick={backToResults}>Retour aux r?sultats</button>
        <button className="btn btn-primary" disabled={!online} onClick={async () => {
          setStep('paying'); await pay(booking);
        }}>Accepter {fcfa(fare)} et payer</button>
      </div>}
      {step === 'paying' && <p role="status">Création de votre réservation…</p>}
      {error && <ErrorState title="Paiement impossible" text={error}/>}
    </Card>
  </div>;
}
