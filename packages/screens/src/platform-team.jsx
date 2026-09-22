import { useRef, useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Badge, Card, SectionTitle, ApiState } from '@leroutier/ui';
import { Users } from 'lucide-react';

// What each authorization actually opens, in the words of the console it
// unlocks. A checkbox labelled `verification` tells somebody nothing, and the
// decision being made on this screen is whether a colleague may open a
// stranger's identity card. It should read like that.
const CAPABILITIES = [
  ['verification', 'Vérifications & KYC', 'Ouvrir les dossiers d’opérateurs et les pièces d’identité, décider d’une vérification.'],
  ['users', 'Utilisateurs & comptes', 'Registre des comptes, activation, demandes de suppression et blocages légaux.'],
  ['finance', 'Finances & règlements', 'Anomalies de paiement, versements et règlements aux opérateurs.'],
  ['incidents', 'Incidents plateforme', 'Incidents déclarés sur l’ensemble du réseau.'],
  ['operations', 'Services & colis', 'Vue plateforme des services publiés et des colis.'],
  ['system', 'Système & capacité', 'Capacité de la base, migrations, état technique et quotas.'],
  ['provisioning', 'Opérateurs & personnel', 'Créer un opérateur, provisionner conducteurs, convoyeurs et agents.'],
];
const labelFor = capability => CAPABILITIES.find(c => c[0] === capability)?.[1] ?? capability;

function CapabilityChoices({ chosen, onChange, disabled }) {
  return <div className="stack">
    {CAPABILITIES.map(([capability, label, description]) =>
      <label key={capability} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
        <input type="checkbox" disabled={disabled} checked={chosen.includes(capability)}
          onChange={e => onChange(e.target.checked ? [...chosen, capability] : chosen.filter(c => c !== capability))}/>
        <span className="grow"><strong className="small">{label}</strong>
          <p className="small muted">{description}</p></span>
      </label>)}
  </div>;
}

function Member({ member, isSelf, canEdit, onChanged }) {
  const { request, online } = useSession();
  const held = member.capabilities ?? [];
  const superadmin = held.includes('superadmin');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(null);

  async function save() {
    const payload = { capabilities: draft }, fingerprint = JSON.stringify(payload);
    if (key.current?.fingerprint !== fingerprint) key.current = { fingerprint, value: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      await request(`/ops/platform-team/${member.id}/grants`, { method: 'PUT', body: payload, key: key.current.value });
      key.current = null; setDraft(null); onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return <Card className="stack">
    <div className="between wrap">
      <div>
        <strong>{member.display_name || 'Sans nom'}</strong>
        <p className="small muted">{member.last_authenticated_at
          ? `Dernière connexion : ${new Date(member.last_authenticated_at).toLocaleDateString('fr-FR')}`
          : 'Jamais connecté'}{member.active ? '' : ' · compte désactivé'}</p>
      </div>
      {superadmin ? <Badge tone="success">Super-administrateur</Badge>
        : <Badge tone={held.length ? 'neutral' : 'warning'}>
          {held.length ? `${held.length} autorisation${held.length > 1 ? 's' : ''}` : 'Aucune autorisation'}</Badge>}
    </div>

    {superadmin ? <p className="small muted">
      Le super-administrateur dispose de toutes les autorisations. Ce rôle est unique et ne peut être ni
      attribué ni retiré depuis cette console.
    </p> : draft === null ? <>
      <div className="controls">
        {[...held].sort().map(capability => <span key={capability} className="service-chip">{labelFor(capability)}</span>)}
      </div>
      {!held.length && <p className="small muted">
        Ce compte peut se connecter mais n’ouvre aucun écran : aucune autorisation ne lui a été accordée.
      </p>}
      {canEdit && !isSelf && <div className="controls">
        <button className="btn btn-soft" disabled={!online} onClick={() => setDraft([...held])}>Modifier les autorisations</button>
      </div>}
      {isSelf && <p className="small muted">Vous ne pouvez pas modifier vos propres autorisations.</p>}
    </> : <>
      <CapabilityChoices chosen={draft} onChange={setDraft} disabled={busy}/>
      {error && <p role="alert">{error}</p>}
      <div className="controls">
        <button className="btn btn-primary" disabled={busy || !online} onClick={save}>Enregistrer</button>
        <button className="btn btn-soft" disabled={busy} onClick={() => { setDraft(null); setError(''); }}>Annuler</button>
      </div>
    </>}
  </Card>;
}

function AddMember({ onAdded }) {
  const { request, online } = useSession();
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(null);

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form);
    const payload = { subject: data.get('subject'), displayName: data.get('name'), capabilities: chosen };
    const fingerprint = JSON.stringify(payload);
    if (key.current?.fingerprint !== fingerprint) key.current = { fingerprint, value: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      await request('/ops/platform-team', { method: 'POST', body: payload, key: key.current.value });
      key.current = null; form.reset(); setChosen([]); onAdded();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return <Card><details><summary>Ajouter un membre de l’équipe</summary>
    <form className="stack" onSubmit={submit}>
      <fieldset disabled={busy || !online} className="stack">
        {/* An identifier, not an e-mail address. LeRoutier never stores e-mail
            addresses on an account, so somebody is named to the platform by the
            identifier their sign-in provider issued — and that is also why this
            console cannot look anybody up for you. */}
        <label>Identifiant d’identité (UID du fournisseur de connexion)
          <input className="control" name="subject" required maxLength={255}/></label>
        <p className="small muted">
          La personne doit déjà posséder un compte LeRoutier. Son identifiant figure dans la console
          d’authentification : LeRoutier n’enregistre pas les adresses e-mail et ne peut pas la retrouver autrement.
        </p>
        <label>Nom affiché<input className="control" name="name" required maxLength={100}/></label>
        <CapabilityChoices chosen={chosen} onChange={setChosen} disabled={busy}/>
        <button className="btn btn-primary">Ajouter</button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  </details></Card>;
}

/**
 * LeRoutier's own staff, and what each of them may open.
 *
 * Visible to anybody holding `provisioning`, editable only by the superadmin —
 * the API enforces both, and this screen only avoids offering controls that
 * would always be refused. Seeing who is on the team is part of running it;
 * changing what they can reach is the single seat's decision.
 */
export function PlatformTeam() {
  const team = useApi('/ops/platform-team');
  const { user } = useSession();
  const superadmin = (user?.platform_capabilities ?? []).includes('superadmin');

  return <div className="stack">
    <SectionTitle title="Équipe plateforme" icon={Users}/>
    <Card className="stack">
      <p className="small muted">
        Chaque membre n’ouvre que les écrans correspondant à ses autorisations. Une autorisation retirée
        prend effet à la requête suivante, sans attendre une reconnexion.
      </p>
      {!superadmin && <p className="small muted">
        Seul le super-administrateur peut modifier ces autorisations.
      </p>}
    </Card>

    {superadmin && <AddMember onAdded={() => team.reload()}/>}

    {team.loading || team.error || !team.data?.length
      ? <ApiState resource={team} empty="Aucun compte plateforme."/>
      : team.data.map(member => <Member key={member.id} member={member} canEdit={superadmin}
        isSelf={member.id === user?.id} onChanged={() => team.reload()}/>)}
  </div>;
}
