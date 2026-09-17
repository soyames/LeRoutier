import { useEffect, useRef, useState } from 'react';
import { useSession } from '@leroutier/config/client';
import { Send, X } from 'lucide-react';

// LeRoutier Assistant: opened from the "Assistant" link in the page footer —
// no floating button, so nothing ever covers the mobile navigation. The
// server resolves identity and role; answers come from deterministic tools
// over real user data, and a model only phrases explanations. Conversation
// history lives in this session's memory only.
//
// Quick commands are predefined questions the user taps; the SAME server
// pipeline answers them with the caller's own data (bookings, parcels,
// departures), so a suggestion is never fabricated.
//
// Keyboard: the panel traps focus while open, Escape closes it and returns
// focus to the opener; the thread is a polite live region.

const WELCOME = 'Bonjour. Je peux vous aider à chercher un trajet, connaître un tarif, suivre un colis ou comprendre votre réservation.';
const QUICK_COMMANDS = [
  'Quels départs depuis Cotonou ?',
  'Statut de ma réservation',
  'Où en est mon colis ?',
  'Quel est le prix de Cotonou vers Parakou ?',
  'Comment annuler une réservation ?',
  'Aide et contact',
];

function Message({ text = '', from, busy = false, failed = false, onRetry }) {
  return <div className={from === 'user' ? 'assistant-msg user' : 'assistant-msg'}>
    <span className="small muted">{from === 'user' ? 'Vous' : 'LeRoutier'}</span>
    {busy ? <p role="status">LeRoutier réfléchit…</p>
      : failed ? <p role="alert">La réponse a échoué. <button className="btn btn-soft" onClick={onRetry}>Réessayer</button></p>
        : <p>{text}</p>}
  </div>;
}

export function Assistant() {
  const { request, online, authLoading } = useSession();
  const [open, setOpen] = useState(false);
  /** @type {{from:string,text?:string,busy?:boolean,failed?:boolean}[]} */
  const initialMessages = [{ from: 'assistant', text: WELCOME }];
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionId = useRef(crypto.randomUUID());
  const panel = useRef(null);
  const opener = useRef(null);
  const input = useRef(null);

  // Opened from the footer link anywhere in the app; remember who opened it
  // so Escape returns focus there.
  useEffect(() => {
    const openAssistant = () => { opener.current = document.activeElement; setOpen(true); };
    window.addEventListener('leroutier:assistant-open', openAssistant);
    return () => window.removeEventListener('leroutier:assistant-open', openAssistant);
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = e => {
      if (e.key === 'Escape') { setOpen(false); opener.current?.focus(); }
      else if (e.key === 'Tab') {
        // Minimal focus trap: keep Tab inside the open panel.
        const nodes = panel.current?.querySelectorAll('button, input');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  async function send(text) {
    const message = (text ?? draft).trim();
    if (!message || busy || !online) return;
    setDraft('');
    setMessages(m => [...m, { from: 'user', text: message }, { from: 'assistant', busy: true }]);
    setBusy(true);
    const index = messages.length + 2;
    try {
      const reply = await request('/assistant', { method: 'POST', body: { sessionId: sessionId.current, message } });
      setMessages(m => { const next = [...m]; next[index] = { from: 'assistant', text: reply.reply }; return next; });
    } catch {
      setMessages(m => { const next = [...m]; next[index] = { from: 'assistant', failed: true }; return next; });
    } finally { setBusy(false); }
  }

  if (!open) return null;
  return <section ref={panel} className="assistant-panel" role="dialog" aria-modal="true" aria-label="Assistant LeRoutier">
    <header className="between">
      <h2>Assistant LeRoutier</h2>
      <button className="btn btn-soft" aria-label="Fermer l’assistant" onClick={() => setOpen(false)}><X size={16} aria-hidden="true"/></button>
    </header>
    {authLoading ? <p role="status">Vérification de votre identité…</p> : null}
    <div className="assistant-thread" aria-live="polite" role="log" aria-label="Conversation">
      {messages.map((m, i) => <Message key={i} {...m} onRetry={() => send(messages[i - 1]?.text)}/>)}
      {messages.length <= 1 && !busy && <div className="assistant-chips" aria-label="Questions rapides">
        {QUICK_COMMANDS.map(c => <button key={c} className="chip" onClick={() => send(c)}>{c}</button>)}
      </div>}
    </div>
    <form className="assistant-input" onSubmit={e => { e.preventDefault(); send(); }}>
      <input ref={input} className="control" value={draft} onChange={e => setDraft(e.target.value)}
        placeholder="Écrivez votre question…" maxLength={1000} disabled={busy || !online} aria-label="Votre message à l’assistant"/>
      <button className="btn btn-primary" type="submit" disabled={busy || !online || !draft.trim()} aria-label="Envoyer"><Send size={16} aria-hidden="true"/></button>
    </form>
    {!online && <p role="status" className="small muted">Hors ligne : l’assistant répondra à la reconnexion.</p>}
  </section>;
}
