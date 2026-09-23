import { useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, SectionTitle, EmptyState, SkeletonCards, fcfa, dateTime } from '@leroutier/ui';
import { ShieldCheck, Handshake, Copy, Check } from 'lucide-react';
import { PlatformOnly } from './platform-ops.jsx';

// The LeRoutier side of the insurance relationship.
//
// One screen, inside Platform Ops, behind the `insurance` capability — not a
// second console and not a partner-facing portal. A partner does not log in
// here: LeRoutier's own coordinator manages the catalogue, sends the referral
// and records what the insurer answered. That keeps the surface small enough
// to be correct, and it means the very first partner can be onboarded with a
// phone call and a spreadsheet rather than an integration project.
//
// The thing this screen exists to make hard: confirming cover that does not
// exist. Confirming demands the insurer's own policy reference, and the field
// is required by the form, by the domain module and by the database.

const PREMIUM_MODES = [
  ['flat', 'Forfait par réservation'],
  ['declared_value_bp', 'Pourcentage de la valeur déclarée'],
  ['included', 'Incluse (personne ne paie de prime)'],
];
const STATUS_TONE = { requested: 'warning', active: 'success', declined: 'danger', cancelled: 'neutral', expired: 'neutral' };
const STATUS_LABEL = { requested: 'À transmettre', active: 'Émise', declined: 'Refusée', cancelled: 'Annulée', expired: 'Échue' };

function Field({ label, value, onChange, type = 'text', required = false, hint = null, options = null }) {
  const id = 'f-' + label.replace(/\W+/g, '-').toLowerCase();
  return <label className="field" htmlFor={id}>
    <span className="small">{label}{required ? ' *' : ''}</span>
    {options
      ? <select id={id} value={value} onChange={e => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      : <input id={id} type={type} value={value} onChange={e => onChange(e.target.value)}/>}
    {hint && <span className="small muted">{hint}</span>}
  </label>;
}

/** The referral, copyable in one action so nobody retypes a phone number. */
function Referral({ policy }) {
  const [copied, setCopied] = useState(false);
  const lines = Object.entries(policy.referral)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${k.endsWith('Value') || k === 'coverAmount' ? fcfa(Number(v)) : v}`);
  return <div className="stack">
    <div className="between wrap">
      <strong className="small">À transmettre à {policy.partner.name}</strong>
      <button className="btn btn-soft" onClick={async () => {
        try { await navigator.clipboard.writeText(lines.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 2000); }
        catch { /* clipboard unavailable: the text is on screen anyway */ }
      }}>{copied ? <Check size={14}/> : <Copy size={14}/>}{copied ? 'Copié' : 'Copier'}</button>
    </div>
    {/* Exactly the fields the person consented to, and no others. The list is
        fixed in insurance.js (SHARED_FIELDS) so it cannot grow here by
        accident when somebody adds a column to bookings. */}
    <pre className="referral-block small">{lines.join('\n')}</pre>
    <p className="small muted">Champs consentis : {(policy.sharedFields ?? []).join(', ')} ·
      consentement {policy.consentVersion} du {dateTime(policy.consentAt)}</p>
  </div>;
}

function Decision({ policy, onDone }) {
  const { request, online } = useSession();
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function decide(status) {
    setBusy(true); setError('');
    try {
      await request(`/ops/insurance/policies/${policy.id}/decision`, { method: 'POST',
        body: { status, ...(status === 'active' ? { partnerReference: reference } : { declinedReason: reason }) } });
      onDone();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="stack">
    <Field label="Référence de police de l’assureur" value={reference} onChange={setReference}
      hint="Obligatoire pour confirmer. Sans elle, rien ne prouve que la garantie existe."/>
    <Field label="Motif de refus" value={reason} onChange={setReason}
      hint="Communiqué tel quel à l’assuré : écrivez-le dans des mots qu’il comprendra."/>
    <div className="controls">
      <button className="btn btn-primary" disabled={busy || !online || !reference.trim()}
        onClick={() => decide('active')}>Confirmer la garantie</button>
      <button className="btn btn-soft" disabled={busy || !online} onClick={() => decide('declined')}>
        Enregistrer un refus</button>
      <button className="btn btn-soft" disabled={busy || !online || policy.sharedAt}
        onClick={async () => {
          setBusy(true);
          try { await request(`/ops/insurance/policies/${policy.id}/shared`, { method: 'POST', body: {} }); onDone(); }
          catch (e) { setError(e.message); } finally { setBusy(false); }
        }}>{policy.sharedAt ? 'Transmis' : 'Marquer comme transmis'}</button>
    </div>
    {error && <p className="small" role="alert">{error}</p>}
  </div>;
}

function PartnerForm({ partner = null, onSaved }) {
  const { request, online } = useSession();
  const [form, setForm] = useState(() => ({
    name: partner?.name ?? '', legalName: partner?.legalName ?? '', kind: partner?.kind ?? 'insurer',
    cimaRegistration: partner?.cimaRegistration ?? '', contactName: partner?.contactName ?? '',
    contactEmail: partner?.contactEmail ?? '', contactPhone: partner?.contactPhone ?? '',
    claimsPhone: partner?.claimsPhone ?? '', claimsEmail: partner?.claimsEmail ?? '',
    claimsUrl: partner?.claimsUrl ?? '', status: partner?.status ?? 'draft',
  }));
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const set = key => value => setForm(f => ({ ...f, [key]: value }));
  return <div className="stack">
    <Field label="Nom commercial" value={form.name} onChange={set('name')} required/>
    <Field label="Raison sociale" value={form.legalName} onChange={set('legalName')}/>
    <Field label="Type" value={form.kind} onChange={set('kind')}
      options={[['insurer', 'Compagnie d’assurance'], ['broker', 'Courtier']]}/>
    <Field label="Numéro d’agrément CIMA" value={form.cimaRegistration} onChange={set('cimaRegistration')}
      hint="Exigé pour activer le partenaire : c’est lui qui rend l’offre licite au regard du code CIMA."/>
    <Field label="Contact — nom" value={form.contactName} onChange={set('contactName')}/>
    <Field label="Contact — e-mail" value={form.contactEmail} onChange={set('contactEmail')}/>
    <Field label="Contact — téléphone" value={form.contactPhone} onChange={set('contactPhone')}/>
    <Field label="Sinistres — téléphone" value={form.claimsPhone} onChange={set('claimsPhone')}
      hint="Montré à l’assuré. Un assureur qu’on ne peut pas joindre est une garantie qui n’existe pas."/>
    <Field label="Sinistres — e-mail" value={form.claimsEmail} onChange={set('claimsEmail')}/>
    <Field label="Sinistres — lien de déclaration" value={form.claimsUrl} onChange={set('claimsUrl')}/>
    <Field label="Statut" value={form.status} onChange={set('status')}
      options={[['draft', 'Brouillon'], ['active', 'Actif'], ['suspended', 'Suspendu']]}/>
    <div className="controls">
      <button className="btn btn-primary" disabled={busy || !online} onClick={async () => {
        setBusy(true); setError('');
        try {
          await request('/ops/insurance/partners', { method: 'POST',
            body: { ...(partner ? { id: partner.id } : {}), ...form } });
          onSaved();
        } catch (e) { setError(e.message); } finally { setBusy(false); }
      }}>{partner ? 'Enregistrer' : 'Créer le partenaire'}</button>
    </div>
    {error && <p className="small" role="alert">{error}</p>}
  </div>;
}

function ProductForm({ partnerId, product, onSaved }) {
  const { request, online } = useSession();
  const [form, setForm] = useState(() => ({
    code: product?.code ?? '', name: product?.name ?? '', summary: product?.summary ?? '',
    scope: product?.scope ?? 'trip', coverAmountMinor: String(product?.coverAmountMinor ?? ''),
    premiumMode: product?.premiumMode ?? 'flat', premiumMinor: String(product?.premiumMinor ?? ''),
    premiumBp: String(product?.premiumBp ?? ''), minDeclaredValueMinor: String(product?.minDeclaredValueMinor ?? ''),
    maxDeclaredValueMinor: String(product?.maxDeclaredValueMinor ?? ''), exclusions: product?.exclusions ?? '',
    termsUrl: product?.termsUrl ?? '', status: product?.status ?? 'draft',
  }));
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const set = key => value => setForm(f => ({ ...f, [key]: value }));
  const num = v => (v === '' ? null : Number(v));
  return <div className="stack">
    <Field label="Code" value={form.code} onChange={set('code')} required/>
    <Field label="Nom affiché" value={form.name} onChange={set('name')} required/>
    <Field label="Résumé" value={form.summary} onChange={set('summary')} required
      hint="Une phrase, lue par le voyageur au moment de choisir."/>
    <Field label="Couvre" value={form.scope} onChange={set('scope')}
      options={[['trip', 'Un trajet'], ['parcel', 'Un colis']]}/>
    <Field label="Capital garanti (FCFA)" value={form.coverAmountMinor} onChange={set('coverAmountMinor')} type="number" required/>
    <Field label="Mode de prime" value={form.premiumMode} onChange={set('premiumMode')} options={PREMIUM_MODES}/>
    {form.premiumMode === 'flat' && <Field label="Prime (FCFA)" value={form.premiumMinor} onChange={set('premiumMinor')} type="number"/>}
    {form.premiumMode === 'declared_value_bp' && <Field label="Taux (points de base, 100 = 1 %)"
      value={form.premiumBp} onChange={set('premiumBp')} type="number"/>}
    <Field label="Valeur déclarée minimale (FCFA)" value={form.minDeclaredValueMinor} onChange={set('minDeclaredValueMinor')} type="number"/>
    <Field label="Valeur déclarée maximale (FCFA)" value={form.maxDeclaredValueMinor} onChange={set('maxDeclaredValueMinor')} type="number"/>
    <Field label="Exclusions" value={form.exclusions} onChange={set('exclusions')}
      hint="Les deux ou trois choses réellement exclues, en clair."/>
    <Field label="Lien des conditions" value={form.termsUrl} onChange={set('termsUrl')}/>
    <Field label="Statut" value={form.status} onChange={set('status')}
      options={[['draft', 'Brouillon'], ['active', 'Proposé aux voyageurs'], ['retired', 'Retiré']]}/>
    <div className="controls">
      <button className="btn btn-primary" disabled={busy || !online} onClick={async () => {
        setBusy(true); setError('');
        try {
          await request('/ops/insurance/products', { method: 'POST', body: {
            ...(product ? { id: product.id } : { partnerId }),
            code: form.code, name: form.name, summary: form.summary, scope: form.scope,
            coverAmountMinor: num(form.coverAmountMinor), premiumMode: form.premiumMode,
            premiumMinor: num(form.premiumMinor) ?? 0, premiumBp: num(form.premiumBp) ?? 0,
            minDeclaredValueMinor: num(form.minDeclaredValueMinor),
            maxDeclaredValueMinor: num(form.maxDeclaredValueMinor),
            exclusions: form.exclusions, termsUrl: form.termsUrl, status: form.status,
          } });
          onSaved();
        } catch (e) { setError(e.message); } finally { setBusy(false); }
      }}>{product ? 'Enregistrer' : 'Ajouter la garantie'}</button>
    </div>
    {error && <p className="small" role="alert">{error}</p>}
  </div>;
}

export function PlatformInsurance() {
  const [tab, setTab] = useState('queue');
  const [status, setStatus] = useState('requested');
  const [editing, setEditing] = useState(null);
  const partners = useApi('/ops/insurance/partners');
  const policies = useApi(`/ops/insurance/policies?status=${status}`);
  const reload = () => { partners.reload(); policies.reload(); setEditing(null); };
  return <PlatformOnly grant="insurance"><div className="stack">
    <SectionTitle title="Assurances & partenaires" icon={ShieldCheck}/>
    <Card className="stack">
      <p><strong>LeRoutier ne porte aucun risque.</strong></p>
      <p className="small muted">Les garanties proposées dans l’application sont souscrites auprès d’un assureur
        agréé ou d’un courtier immatriculé. LeRoutier présente l’offre, recueille le consentement et transmet
        le strict nécessaire ; l’assureur émet la police, encaisse la prime et instruit les sinistres.</p>
      <p className="small muted">Une demande reste « à transmettre » tant que l’assureur n’a pas répondu. Elle ne
        devient « émise » qu’avec une référence de police : l’assuré ne doit jamais croire qu’il est couvert
        avant de l’être.</p>
    </Card>
    <div className="controls">
      <button className={`btn ${tab === 'queue' ? 'btn-primary' : 'btn-soft'}`} onClick={() => setTab('queue')}>Demandes</button>
      <button className={`btn ${tab === 'partners' ? 'btn-primary' : 'btn-soft'}`} onClick={() => setTab('partners')}>Partenaires</button>
    </div>

    {tab === 'queue' && <>
      <div className="controls">
        {['requested', 'active', 'declined', 'all'].map(s => <button key={s}
          className={`btn ${status === s ? 'btn-primary' : 'btn-soft'}`} onClick={() => setStatus(s)}>
          {s === 'all' ? 'Toutes' : STATUS_LABEL[s]}</button>)}
      </div>
      {policies.loading ? <SkeletonCards count={3}/>
        : policies.error ? <Card><p role="alert">{policies.error}</p></Card>
          : (policies.data ?? []).length ? policies.data.map(p => <Card key={p.id} className="stack">
            <div className="between wrap">
              <div><strong>{p.productName}</strong>
                <p className="small muted">{p.scope === 'trip' ? 'Trajet' : 'Colis'} · {p.partner.name} ·
                  demandée le {dateTime(p.requestedAt)}</p></div>
              <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
            </div>
            <div className="summary">
              <div className="row"><span>Capital garanti</span><span>{fcfa(p.coverAmountMinor)}</span></div>
              <div className="row"><span>Prime</span><span>{p.premiumMinor ? fcfa(p.premiumMinor) : 'Incluse'}</span></div>
              {p.partnerReference && <div className="row"><span>Police</span><span>{p.partnerReference}</span></div>}
              {p.declinedReason && <div className="row"><span>Motif</span><span>{p.declinedReason}</span></div>}
              <div className="row"><span>Transmis à l’assureur</span>
                <span>{p.sharedAt ? dateTime(p.sharedAt) : 'Pas encore'}</span></div>
            </div>
            {p.status === 'requested' && <><Referral policy={p}/><Decision policy={p} onDone={reload}/></>}
          </Card>)
            : <EmptyState icon={Handshake} title="Aucune demande"
              text="Les demandes de garantie des voyageurs et des expéditeurs apparaîtront ici."/>}
    </>}

    {tab === 'partners' && <>
      {partners.loading ? <SkeletonCards count={2}/>
        : partners.error ? <Card><p role="alert">{partners.error}</p></Card>
          : <>
            {(partners.data ?? []).map(p => <Card key={p.id} className="stack">
              <div className="between wrap">
                <div><strong>{p.name}</strong>
                  <p className="small muted">{p.kind === 'broker' ? 'Courtier' : 'Compagnie d’assurance'} ·
                    {p.cimaRegistration ? ` agrément ${p.cimaRegistration}` : ' agrément non renseigné'} · {p.country}</p></div>
                <Badge tone={p.status === 'active' ? 'success' : p.status === 'suspended' ? 'danger' : 'warning'}>
                  {p.status === 'active' ? 'Actif' : p.status === 'suspended' ? 'Suspendu' : 'Brouillon'}</Badge>
              </div>
              {p.status !== 'active' && !p.cimaRegistration && <p className="small" role="status">
                Renseignez le numéro d’agrément CIMA avant d’activer ce partenaire.</p>}
              <div className="summary">
                {p.products.map(pr => <div className="row" key={pr.id}>
                  <span>{pr.name} · {pr.scope === 'trip' ? 'trajet' : 'colis'}</span>
                  <span>{fcfa(pr.coverAmountMinor)} · {pr.status === 'active' ? 'proposé' : pr.status}</span>
                </div>)}
                {!p.products.length && <div className="row"><span>Aucune garantie enregistrée</span><span>–</span></div>}
              </div>
              <div className="controls">
                <button className="btn btn-soft" onClick={() => setEditing(editing?.partner === p.id && !editing.product
                  ? null : { partner: p.id })}>Modifier le partenaire</button>
                <button className="btn btn-soft" onClick={() => setEditing({ partner: p.id, product: 'new' })}>
                  Ajouter une garantie</button>
                {p.products.map(pr => <button key={pr.id} className="btn btn-soft"
                  onClick={() => setEditing({ partner: p.id, product: pr.id })}>Modifier « {pr.name} »</button>)}
              </div>
              {editing?.partner === p.id && !editing.product
                && <PartnerForm partner={p} onSaved={reload}/>}
              {editing?.partner === p.id && editing.product
                && <ProductForm partnerId={p.id} onSaved={reload}
                  product={editing.product === 'new' ? null : p.products.find(x => x.id === editing.product)}/>}
            </Card>)}
            <Card className="stack">
              <strong>Nouveau partenaire</strong>
              {editing?.partner === 'new'
                ? <PartnerForm onSaved={reload}/>
                : <div className="controls"><button className="btn btn-primary"
                  onClick={() => setEditing({ partner: 'new' })}>Enregistrer un assureur ou un courtier</button></div>}
            </Card>
          </>}
    </>}
  </div></PlatformOnly>;
}
