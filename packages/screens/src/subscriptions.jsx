import { useRef, useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, SectionTitle, fcfa, ApiState } from '@leroutier/ui';
import { SUBSCRIPTION_PRICES } from '@leroutier/domain';
import { Building2, Car, Check, Receipt } from 'lucide-react';
const periodNames = { monthly: 'Mensuel', halfYear: 'Six mois', yearly: 'Annuel' };
const planNames = { independent: 'Chauffeur indépendant', company: 'Compagnie de transport' };
const date = value => value ? new Intl.DateTimeFormat('fr-BJ', { dateStyle: 'long', timeZone: 'Africa/Porto-Novo' }).format(new Date(value)) : 'À confirmer';
const paymentNames = { pending: 'Paiement en attente de vérification', failed: 'Paiement échoué', cancelled: 'Paiement annulé', succeeded: 'Paiement confirmé', refunded: 'Paiement remboursé' };
export function SubscriptionCards({ onChoose, operatorType = null }) {
  return <div className="grid grid-2 subscription-cards">{Object.entries(SUBSCRIPTION_PRICES).filter(([type]) => !operatorType || type === operatorType).map(([type, prices]) => {
    const Icon = type === 'company' ? Building2 : Car;
    return <Card key={type} className="stack subscription-card">
      <div className="row"><Icon size={24} aria-hidden="true"/><h2>{planNames[type]}</h2></div>
      <p className="muted">{type === 'company' ? 'Votre flotte, vos équipes et vos lignes dans un seul espace.' : 'Votre véhicule, vos départs et vos recettes au même endroit.'}</p>
      <p className="subscription-price"><strong>{fcfa(prices.monthly)}</strong><span> / mois · XOF</span></p>
      <div className="summary"><div className="row"><span>Six mois</span><strong>{fcfa(prices.halfYear)}</strong></div><div className="row"><span>Un an</span><strong>{fcfa(prices.yearly)}</strong></div></div>
      <p className="row small"><Check size={18} aria-hidden="true"/>Gestion des départs, billets et suivi des recettes</p>
      <p className="small">Gratuit jusqu’au 30 avril 2027 inclus, heure du Bénin. Paiement volontaire à partir du 1er mai. Aucun prélèvement automatique.</p>
      <button className="btn btn-primary" onClick={() => onChoose(type)}>Choisir cette formule</button>
    </Card>;
  })}</div>;
}
export function OperatorSubscription() {
  const { user, request, online } = useSession();
  const eligible = user?.operator_id && (user.role === 'ops' || (user.role === 'driver' && user.operator_type === 'independent'));
  const resource = useApi(eligible ? '/operator/subscription' : null);
  const [choosing, setChoosing] = useState(false), [period, setPeriod] = useState('monthly');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const key = useRef(null);
  const data = resource.data, subscription = data?.subscription;
  if (!eligible) return null;
  if (!data) return <ApiState resource={resource}/>;
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    const form = new FormData(event.currentTarget);
    try {
      const billingContact = Object.fromEntries(['name','email','phone','address'].map(k => [k, String(form.get(k) ?? '').trim()]));
      await request('/operator/subscription', { method: 'POST', body: { billingPeriod: period, billingContact } });
      if (subscription.free) { setNotice('Formule enregistrée. Aucun montant débité. Votre accès reste gratuit jusqu’au 30 avril 2027 inclus.'); setChoosing(false); }
      else {
        key.current ??= crypto.randomUUID();
        const result = await request('/operator/subscription/checkout', { method: 'POST', key: key.current, body: { paymentMethod: String(form.get('paymentMethod')) } });
        key.current = null;
        setNotice('Paiement en attente : votre abonnement sera activé après vérification du prestataire.');
        if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      }
      resource.reload();
    } catch (err) { setError(err.message); resource.reload(); } finally { setBusy(false); }
  }
  async function verify(id) {
    setBusy(true); setError('');
    try { const result = await request(`/operator/subscription/payments/${id}/reconcile`, { method: 'POST' }); setNotice(paymentNames[result.status] ?? 'Vérification en attente'); resource.reload(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <section className="stack" aria-label="Abonnement professionnel">
    <SectionTitle title="Votre abonnement professionnel" icon={Receipt}/>
    <Card className="stack"><div className="between wrap"><strong>{planNames[data.operatorType]}</strong><Badge tone={subscription.active ? 'success' : 'warning'}>{subscription.free ? 'Période gratuite' : subscription.active ? 'Confirmé' : 'Paiement requis'}</Badge></div>
      <div className="summary"><div className="row"><span>Période choisie</span><span>{periodNames[subscription.billingPeriod] ?? 'À choisir'}</span></div><div className="row"><span>Prochaine échéance · Bénin</span><span>{date(subscription.nextDueAt)}</span></div></div>
      <p className="small muted">L’abonnement est distinct de vos recettes et versements. Le renouvellement nécessite un nouveau paiement confirmé.</p>
    </Card>
    {error && <p role="alert">{error}</p>}{notice && <p role="status" aria-live="polite">{notice}</p>}
    {!choosing ? <SubscriptionCards operatorType={data.operatorType} onChoose={() => { setPeriod(subscription.billingPeriod ?? 'monthly'); setChoosing(true); }}/>
      : <Card className="stack"><h2>Vérifiez votre formule avant de confirmer</h2><form className="stack" onSubmit={submit}>
        <fieldset disabled={busy || !online} className="stack"><legend>{planNames[data.operatorType]}</legend>
          <label>Période de facturation<select className="control" value={period} onChange={e => setPeriod(e.target.value)}>{Object.entries(periodNames).map(([id, label]) => <option value={id} key={id}>{label} · {fcfa(data.prices[id])}</option>)}</select></label>
          <div className="summary"><div className="row"><span>Abonnement · XOF</span><strong>{fcfa(data.prices[period])}</strong></div><div className="row"><span>Frais LeRoutier sur l’abonnement</span><span>{fcfa(0)}</span></div><div className="row"><span>Frais du prestataire</span><span>{subscription.free ? 'Aucun paiement' : 'À vérifier sur la page sécurisée du prestataire'}</span></div><div className="row"><strong>{subscription.free ? 'Total dû aujourd’hui' : 'Montant hors frais du prestataire'}</strong><strong>{fcfa(subscription.free ? 0 : data.prices[period])}</strong></div></div>
          {subscription.free && <p role="status">Votre formule reste gratuite jusqu’au 30 avril 2027 inclus. Le paiement sera proposé à partir du 1er mai 2027.</p>}
          <label>Nom / raison sociale<input autoFocus className="control" name="name" required minLength={2} maxLength={160} defaultValue={subscription.billingContact?.name ?? user.operator_name ?? ''} autoComplete="organization"/></label>
          <label>Adresse de facturation<input className="control" name="address" required minLength={3} maxLength={300} defaultValue={subscription.billingContact?.address ?? ''} autoComplete="street-address"/></label>
          <label>Email de contact<input className="control" name="email" type="email" required defaultValue={subscription.billingContact?.email ?? user.email ?? ''} autoComplete="email"/></label>
          <label>Téléphone<input className="control" name="phone" type="tel" required pattern="[+0-9 ()-]{8,25}" defaultValue={subscription.billingContact?.phone ?? user.phone ?? ''} autoComplete="tel"/></label>
          {!subscription.free && <label>Moyen de paiement<select className="control" name="paymentMethod" required><option value="">Choisir un moyen disponible</option>{data.paymentMethods.map(method => <option key={method.id} value={method.id}>{method.label}</option>)}</select></label>}
          <label className="row"><input type="checkbox" required/>Je confirme mes coordonnées, la période et le montant. Aucun prélèvement automatique.</label>
          <div className="controls"><button className="btn btn-primary" disabled={!subscription.free && !data.paymentMethods.length}>{busy ? 'Vérification…' : subscription.free ? 'Confirmer ma formule gratuite' : `Payer ${fcfa(data.prices[period])}`}</button><button type="button" className="btn btn-soft" onClick={() => setChoosing(false)}>Retour</button></div>
        </fieldset>
      </form></Card>}
    {data.receipts.map(receipt => <Card key={receipt.id} className="stack"><div className="between wrap"><strong>Reçu d’abonnement · {receipt.id}</strong><span role="status">{paymentNames[receipt.status]}</span></div><p>{periodNames[receipt.billing_period]} · {fcfa(receipt.amount_minor)} · XOF</p>
      {receipt.status === 'succeeded' && <><p>Vendeur : LeRoutier · Paiement vérifié le {date(receipt.verified_at)} · Référence {receipt.provider_reference}</p><p>Facturé à : {receipt.billing_contact?.name} · {receipt.billing_contact?.address}</p><p>Abonnement : {fcfa(receipt.amount_minor)} · Frais du prestataire fournis : {fcfa(receipt.provider_fee_minor ?? 0)} · Payé : {fcfa(receipt.amount_minor+(receipt.provider_fee_minor ?? 0))}</p><p>Période : {date(receipt.period_start)} au {date(receipt.period_end)}</p><button className="btn btn-soft" onClick={() => window.print()}>Imprimer le reçu</button></>}
      {receipt.status === 'pending' && <div className="controls">{receipt.checkout_url && <a className="btn btn-primary" href={receipt.checkout_url}>Continuer le paiement sécurisé</a>}<button className="btn btn-soft" disabled={busy || !online} onClick={() => verify(receipt.id)}>Vérifier le paiement</button></div>}
    </Card>)}
  </section>;
}
export function OperatorCashReconciliation() {
  const { user, request, online } = useSession();
  const eligible = user?.operator_id && (user.role === 'ops' || user.operator_type === 'independent');
  const money = useApi(eligible ? '/operator/settlements' : null), consent = useApi(eligible ? '/operator/payout-schedule' : null), capability = useApi(eligible ? '/operator/payout-capability' : null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  if (!eligible) return null;
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try { await request('/operator/payout-schedule', { method: 'POST', body: { enabled: form.get('enabled') === 'on', consentVersion: 'monthly-v1', phoneNumber: String(form.get('phone')), country: 'BJ', network: null } }); consent.reload(); setNotice('Préférence de versement enregistrée.'); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <Card className="stack"><SectionTitle title="Espèces & versements mensuels"/>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <p>Les espèces sont déjà reçues par votre activité. Elles ne sont pas versées une seconde fois. Les frais LeRoutier collectés avec la vente restent à reverser à la plateforme.</p>
    <div className="summary">{(money.data?.summary.cashSales ?? []).map(sale => <div key={sale.id} className="stack"><strong>Vente {sale.booking_id}</strong><span>Tarif reçu : {fcfa(sale.fare_minor)} · Frais LeRoutier : {fcfa(sale.fee_minor)}</span><span>Reversé à LeRoutier : {fcfa(sale.collected_minor)} · À reverser : {fcfa(sale.fee_minor-sale.collected_minor)}</span></div>)}</div>
    <p className="small">Dette de remboursements à compenser : {fcfa(money.data?.summary.outstandingReversals ?? 0)}</p>
    <p role="status">{capability.data?.canRequest ? 'Versements disponibles après validation.' : 'Versements prestataire indisponibles ou non vérifiés. Contactez la régulation pour rapprocher vos recettes et un règlement manuel.'}</p>
    {consent.data && <form className="stack" onSubmit={save} key={String(consent.data.enabled)}><label>Téléphone Mobile Money<input className="control" name="phone" type="tel" pattern="[0-9]{8,15}" required defaultValue={consent.data.phoneNumber ?? user.phone ?? ''}/></label><label className="row"><input name="enabled" type="checkbox" defaultChecked={consent.data.enabled}/>J’accepte les versements mensuels des recettes en ligne du mois précédent, heure du Bénin, après compensation des remboursements . Je peux désactiver cette option.</label><button className="btn btn-soft" disabled={busy || !online}>Enregistrer mon choix</button></form>}
  </Card>;
}
export function PlatformCommerceReconciliation() {
  const { user, request, online } = useSession();
  const allowed = !user?.operator_id && (user?.platform_capabilities ?? []).includes('finance');
  const fees = useApi(allowed ? '/ops/cash-fees' : null), payouts = useApi(allowed ? '/ops/operator-payouts' : null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function action(path, body) {
    setBusy(true); setError(''); setNotice('');
    try { await request(path, { method: 'POST', body }); fees.reload(); payouts.reload(); setNotice('Rapprochement enregistré dans le journal financier.'); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  if (!allowed) return null;
  return <Card className="stack"><h3>Rapprochement des espèces et règlements opérateurs</h3>
    <p>Les frais collectés en espèces restent dus à LeRoutier. Enregistrez uniquement une réception réelle et vérifiée. Un règlement manuel exige la confirmation du mouvement bancaire.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button className="btn btn-soft" disabled={busy || !online} onClick={() => action('/ops/operator-monthly-payouts', {})}>Préparer les règlements du mois précédent</button>
    <ApiState resource={fees}/>{(fees.data ?? []).map(fee => <details key={fee.id}><summary>{fee.operator_name} · Tarif encaissé {fcfa(fee.fare_minor)} · Frais à reverser {fcfa(fee.fee_minor-fee.collected_minor)}</summary>
      {fee.collected_minor < fee.fee_minor && <form className="stack" onSubmit={event => { event.preventDefault(); const f = new FormData(event.currentTarget); action(`/ops/cash-fees/${fee.id}/collect`, { amountMinor: Number(f.get('amount')), reference: String(f.get('reference')) }); }}>
        <label>Frais réellement reçus (XOF)<input className="control" name="amount" type="number" min="1" max={fee.fee_minor-fee.collected_minor} required/></label>
        <label>Référence de réception vérifiée<input className="control" name="reference" required minLength={8} maxLength={150}/></label>
        <button className="btn btn-soft" disabled={busy || !online}>Enregistrer la réception des frais</button></form>}
    </details>)}
    <ApiState resource={payouts}/>{(payouts.data ?? []).map(payout => <details key={payout.id}><summary>{payout.operatorName} · {fcfa(payout.amountMinor)} · {payout.status} · Compensation remboursements {fcfa(payout.debtOffsetMinor)}</summary>
      {((payout.status === 'requested' && !payout.providerReference) || payout.status === 'failed') && <form className="stack" onSubmit={event => { event.preventDefault(); const f = new FormData(event.currentTarget); action(`/ops/operator-payouts/${payout.id}/manual-confirmation`, { confirmedAmountMinor: payout.amountMinor, reference: String(f.get('reference')), confirmation: String(f.get('confirmation')) }); }}>
        <label>Référence du transfert bancaire effectué<input className="control" name="reference" required minLength={8} maxLength={150}/></label>
        <label>Preuve vérifiée du mouvement d’argent<textarea className="control" name="confirmation" required minLength={10} maxLength={500}/></label>
        <label className="row"><input type="checkbox" required/>Je confirme que {fcfa(payout.amountMinor)} ont été versés à cet opérateur.</label>
        <button className="btn btn-soft" disabled={busy || !online}>Confirmer le règlement manuel effectué</button></form>}
      {payout.status === 'processing' && <button className="btn btn-soft" disabled={busy || !online} onClick={() => action(`/ops/operator-payouts/${payout.id}/reconcile`, {})}>Réconcilier auprès du prestataire</button>}
    </details>)}
  </Card>;
}
