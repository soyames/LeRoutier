import { useState } from 'react';
import { useSession } from '@leroutier/config/client';

export function ParcelPickup({ parcelId, onComplete, label = 'Remettre avec le code' }) {
  const { request, online } = useSession();
  const [open, setOpen] = useState(false), [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!open) return <button className="btn btn-primary" disabled={!online} onClick={() => setOpen(true)}>{label}</button>;
  return <form className="stack" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { await request(`/parcels/${parcelId}/pickup`, { method:'POST', body:{code} }); setCode(''); setOpen(false); onComplete(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }}>
    <label>Code de retrait du destinataire<input className="control" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e => setCode(e.target.value.replace(/\D/g,''))}/></label>
    <p className="small muted">Vérifiez le destinataire avant la remise. Le QR de suivi ne remplace pas ce code.</p>
    {error && <p role="alert">{error}</p>}
    <div className="controls"><button className="btn btn-primary" disabled={busy || !online || code.length !== 6}>{busy ? 'Vérification…' : 'Confirmer la remise'}</button>
      <button type="button" className="btn btn-soft" disabled={busy} onClick={() => { setOpen(false); setCode(''); }}>Retour</button></div>
  </form>;
}
