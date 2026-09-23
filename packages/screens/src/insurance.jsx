import { useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, fcfa } from '@leroutier/ui';
import { ShieldCheck, ShieldAlert, ShieldQuestion, ExternalLink, Phone } from 'lucide-react';

// Insurance, as a passenger or a sender sees it.
//
// The whole screen is built around one refusal: LeRoutier must never render a
// sentence that reads "you are covered" until an insurer has said so. A
// request that has not been answered says it is a request. That is why the
// states below are four and not two, and why `requested` is worded as a
// pending hand-off rather than as a quiet success.
//
// The second rule is that this is genuinely optional. It is never preselected,
// declining is one tap and costs nothing, and nothing here can block or delay
// the booking it sits beside.

const STATES = {
  requested: { tone: 'warning', icon: ShieldQuestion, label: 'Demande transmise',
    text: 'Votre demande est partie chez l’assureur. Vous n’êtes pas encore couvert : '
      + 'nous vous prévenons dès qu’il a répondu.' },
  active: { tone: 'success', icon: ShieldCheck, label: 'Garantie active',
    text: 'L’assureur a émis votre garantie.' },
  declined: { tone: 'danger', icon: ShieldAlert, label: 'Garantie refusée',
    text: 'L’assureur n’a pas retenu cette demande. Votre trajet et votre paiement ne changent pas.' },
  cancelled: { tone: 'neutral', icon: ShieldAlert, label: 'Demande annulée',
    text: 'Cette demande de garantie a été annulée.' },
  expired: { tone: 'neutral', icon: ShieldAlert, label: 'Garantie échue',
    text: 'Cette garantie a pris fin avec le service qu’elle couvrait.' },
};

const premiumLabel = offer => offer.premiumMode === 'included'
  ? 'Incluse' : offer.premiumMinor > 0 ? fcfa(offer.premiumMinor) : 'Sans supplément';

/**
 * The offer block, shown beside a fare or a parcel quote.
 *
 * `subject` is the booking or parcel this would attach to, and is null while
 * the passenger is still deciding — at checkout, the booking does not exist
 * until they continue to payment. So this component has two jobs: show the
 * offer honestly, and hand the chosen product id back up so the flow can
 * attach it once there is something to attach it to.
 */
export function InsuranceOffer({ scope, declaredValueMinor = 0, chosen, onChoose, disabled = false }) {
  const query = `/insurance/offers?scope=${scope}`
    + (declaredValueMinor ? `&declaredValueMinor=${declaredValueMinor}` : '');
  const offers = useApi(query);
  // No partner, no offer, no block. An empty state here would be an
  // advertisement for something LeRoutier cannot sell.
  if (offers.loading || offers.error || !(offers.data ?? []).length) return null;
  const list = offers.data;
  return <Card className="stack insurance-offer">
    <div className="between wrap">
      <div><strong>Assurance {scope === 'trip' ? 'voyage' : 'colis'}</strong>
        <p className="small muted">Facultatif. Proposé par un assureur partenaire, pas par LeRoutier.</p></div>
      <Badge tone="neutral">Option</Badge>
    </div>
    <div className="insurance-options" role="radiogroup" aria-label={`Assurance ${scope === 'trip' ? 'voyage' : 'colis'}`}>
      {list.map(offer => {
        const picked = chosen?.productId === offer.productId;
        return <button key={offer.productId} type="button" role="radio" aria-checked={picked} disabled={disabled}
          className={`insurance-option${picked ? ' chosen' : ''}`}
          onClick={() => onChoose(picked ? null : offer)}>
          <span className="insurance-option-head">
            <strong>{offer.name}</strong>
            <span className="insurance-premium">{premiumLabel(offer)}</span>
          </span>
          <small>{offer.summary}</small>
          <small className="muted">Capital garanti {fcfa(offer.coverAmountMinor)} · {offer.partner.name}
            {offer.paidTo === 'partner' && offer.premiumMinor > 0 ? ' · payable auprès de l’assureur' : ''}</small>
          {offer.exclusions && <small className="muted">Exclusions : {offer.exclusions}</small>}
          {offer.termsUrl && <a className="small" href={offer.termsUrl} target="_blank" rel="noreferrer noopener"
            onClick={event => event.stopPropagation()}>Conditions <ExternalLink size={12}/></a>}
        </button>;
      })}
    </div>
    {chosen && <p className="small" role="status">
      {/* The consent sentence. It names the recipient, the purpose and the
          fields, because "j'accepte les conditions" is not a consent to a
          transfer of personal data to a third party. */}
      En confirmant, vous demandez cette garantie à <strong>{chosen.partner.name}</strong> et vous acceptez que
      LeRoutier lui transmette votre nom, votre téléphone et les informations
      {scope === 'trip' ? ' de ce trajet' : ' de cet envoi'} nécessaires à l’établissement du contrat.
      {chosen.paidTo === 'partner' && chosen.premiumMinor > 0
        ? ' La prime est réglée directement à l’assureur ; elle n’est pas incluse dans le montant payé à LeRoutier.'
        : ''}
    </p>}
    {chosen && <button type="button" className="btn btn-soft" disabled={disabled} onClick={() => onChoose(null)}>
      Continuer sans assurance</button>}
  </Card>;
}

/**
 * The cover attached to a booking or a parcel, after the fact.
 *
 * Shown on the ticket and in the parcel detail. Its job is to be accurate
 * about the state and to make the claims route reachable — an insurer nobody
 * can telephone is a policy that does not exist in practice.
 */
export function InsurancePolicy({ scope, subjectId }) {
  const path = scope === 'trip' ? `/bookings/${subjectId}/insurance` : `/parcels/${subjectId}/insurance`;
  const policy = useApi(subjectId ? path : null);
  const { request } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (policy.loading || policy.error || !policy.data) return null;
  const p = policy.data;
  const state = STATES[p.status] ?? STATES.requested;
  const Icon = state.icon;
  const claims = [
    p.partner.claimsPhone && { key: 'phone', href: `tel:${p.partner.claimsPhone}`, label: p.partner.claimsPhone, icon: Phone },
    p.partner.claimsUrl && { key: 'url', href: p.partner.claimsUrl, label: 'Déclarer un sinistre', icon: ExternalLink },
    p.partner.claimsEmail && { key: 'mail', href: `mailto:${p.partner.claimsEmail}`, label: p.partner.claimsEmail, icon: ExternalLink },
  ].filter(Boolean);
  return <Card className="stack">
    <div className="between wrap">
      <div><strong>{p.productName}</strong>
        <p className="small muted">{p.partner.name}</p></div>
      <Badge tone={state.tone}><Icon size={12}/>{state.label}</Badge>
    </div>
    <p className="small">{state.text}</p>
    <div className="summary">
      <div className="row"><span>Capital garanti</span><span>{fcfa(p.coverAmountMinor)}</span></div>
      <div className="row"><span>Prime</span><span>
        {p.premiumCollectedBy === 'none' ? 'Incluse' : `${fcfa(p.premiumMinor)} · réglée à l’assureur`}</span></div>
      {/* Only ever rendered when the insurer actually issued one. */}
      {p.partnerReference && <div className="row"><span>Référence de police</span><span>{p.partnerReference}</span></div>}
      {p.declinedReason && <div className="row"><span>Motif</span><span>{p.declinedReason}</span></div>}
    </div>
    {p.status === 'active' && claims.length > 0 && <div className="stack">
      <strong className="small">En cas de sinistre</strong>
      <p className="small muted">La déclaration se fait auprès de l’assureur. LeRoutier n’instruit pas les sinistres.</p>
      <div className="controls">{claims.map(c => <a key={c.key} className="btn btn-soft" href={c.href}
        {...(c.key === 'url' ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
        <c.icon size={14}/>{c.label}</a>)}</div>
    </div>}
    {p.status === 'requested' && <div className="controls">
      <button className="btn btn-soft" disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { await request(`/insurance/policies/${p.id}/cancel`, { method: 'POST', body: {} }); policy.reload(); }
        catch (e) { setError(e.message); } finally { setBusy(false); }
      }}>Annuler cette demande</button>
    </div>}
    {error && <p className="small" role="alert">{error}</p>}
  </Card>;
}
