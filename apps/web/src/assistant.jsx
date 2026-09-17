import { useEffect, useRef, useState } from 'react';
import { useSession } from '@leroutier/config/client';
import { MessageCircle, Send, X } from 'lucide-react';

// LeRoutier Assistant: an accessible, mobile-first conversational drawer.
//
// The server resolves identity and role; the assistant answers from domain
// data through deterministic tools, and a model only ever phrases an
// explanation. Conversation history lives in this session's memory only —
// nothing is persisted, so one user's history can never leak to another.
//
// Keyboard: the launcher is a real button; the panel traps focus while open,
// Escape closes it and returns focus to the launcher; the message list is a
// polite live region so screen readers hear answers as they arrive.

const WELCOME = 'Bonjour. Je peux vous aider à chercher un trajet, connaître un tarif, suivre un colis ou comprendre votre réservation.';

function Message({ text = '', from, busy = false, failed = false, onRetry }) {
  return <div className={from === 'user' ? 'assistant-msg user' : 'assistant-msg'} role={from === 'assistant' ? 'listitem' : undefined}>
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
  const [failedIndex, setFailedIndex] = useState(null);
  const sessionId = useRef(crypto.randomUUID());
  const panel = useRef(null);
  const launcher = useRef(null);
  const input = useRef(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = e => {
      if (e.key === 'Escape') { setOpen(false); launcher.current?.focus(); }
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
    setFailedIndex(null);
    setMessages(m => [...m, { from: 'user', text: message }, { from: 'assistant', busy: true }]);
    setBusy(true);
    const index = messages.length + 2;
    try {
      const reply = await request('/assistant', { method: 'POST', body: { sessionId: sessionId.current, message } });
      setMessages(m => { const next = [...m]; next[index] = { from: 'assistant', text: reply.reply }; return next; });
    } catch {
      setMessages(m => { const next = [...m]; next[index] = { from: 'assistant', failed: true }; return next; });
      setFailedIndex(index);
    } finally { setBusy(false); }
  }

  return <>
    <button ref={launcher} className="assistant-launcher" aria-label="Ouvrir l’assistant LeRoutier"
      aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <MessageCircle size={22} aria-hidden="true"/>
    </button>
    {open && <section ref={panel} className="assistant-panel" role="dialog" aria-modal="true" aria-label="Assistant LeRoutier">
      <header className="between">
        <h2>Assistant LeRoutier</h2>
        <button className="btn btn-soft" aria-label="Fermer l’assistant" onClick={() => { setOpen(false); launcher.current?.focus(); }}><X size={16} aria-hidden="true"/></button>
      </header>
      {authLoading ? <p role="status">Vérification de votre identité…</p> : null}
      <div className="assistant-thread" aria-live="polite" role="log" aria-label="Conversation">
        {messages.map((m, i) => <Message key={i} {...m} onRetry={() => send(messages[i - 1]?.text)}/>)}
      </div>
      <form className="assistant-input" onSubmit={e => { e.preventDefault(); send(); }}>
        <input ref={input} className="control" value={draft} onChange={e => setDraft(e.target.value)}
          placeholder="Écrivez votre question…" maxLength={1000} disabled={busy || !online} aria-label="Votre message à l’assistant"/>
        <button className="btn btn-primary" type="submit" disabled={busy || !online || !draft.trim()} aria-label="Envoyer"><Send size={16} aria-hidden="true"/></button>
      </form>
      {!online && <p role="status" className="small muted">Hors ligne : l’assistant répondra à la reconnexion.</p>}
      {failedIndex !== null && busy && <p role="status" className="small muted">Nouvel essai en cours…</p>}
    </section>}
  </>;
}
