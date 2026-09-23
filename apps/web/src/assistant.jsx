import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@leroutier/config/client';
import { MessagesSquare, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { canPrompt, installSteps, isInstalled, promptInstall, INSTALL_VALUE } from './pwa-install.js';

// LeRoutier Assistant.
//
// Opened from the "Assistant" footer link and from the home page — never from a
// floating button, which on a phone would sit on top of the bottom navigation.
// The server resolves identity and role; answers come from deterministic tools
// over real data, and a model only phrases explanations. History lives in this
// session's memory only.
//
// Two design rules drive this file:
//
//   1. Every suggestion maps to an intent the server actually implements. A
//      chip that produces "je ne comprends pas" is worse than no chip, and a
//      chip promising something LeRoutier cannot do is a lie with a button.
//   2. A conversation must never dead-end. The assistant answers, then offers
//      the next reasonable question — chosen from the intent the server reports
//      it just handled, so the follow-ups are about what was actually asked.
//
// Keyboard: the panel traps focus while open, Escape closes it and returns
// focus to whatever opened it; the thread is a polite live region.

const WELCOME = 'Bonjour. Je réponds à partir des services réellement publiés : départs entre deux villes, tarifs, suivi de colis, état de vos réservations. Si aucune offre n’existe sur un trajet, je vous le dis plutôt que d’inventer un horaire.';

// Answered here, not by the server. Installing is something only this browser
// can do — the install dialog is a browser API tied to a user gesture, and no
// round trip can open it. Routing this to /assistant would produce "je ne
// comprends pas" for the one question the client can answer perfectly.
export const INSTALL_QUESTION = 'Installer LeRoutier sur mon téléphone';

// Grouped so the panel shows what the assistant is *for*, not a flat pile of
// sentences. Each entry is a question the deterministic router recognises.
const SUGGESTION_GROUPS = [
  {
    title: 'Voyager',
    items: [
      'Quels départs depuis Cotonou ?',
      'Quels départs de Cotonou vers Parakou ?',
      'Quel est le prix de Cotonou vers Parakou ?',
      'Quels départs de Cotonou vers Porto-Novo ?',
      'Quels départs de Cotonou vers Bohicon ?',
      'Quels départs de Cotonou vers Natitingou ?',
    ],
  },
  {
    title: 'Colis',
    items: [
      'Où en est mon colis ?',
      'Comment envoyer un colis ?',
      'Comment retirer un colis ?',
    ],
  },
  {
    title: 'Ma réservation',
    items: [
      'Statut de ma réservation',
      'Où est mon bus ?',
      'Quand arrive mon bus ?',
      'Comment annuler une réservation ?',
      'Suis-je remboursé si j’annule ?',
    ],
  },
  {
    title: 'Aide et données',
    items: [
      INSTALL_QUESTION,
      'Aide et contact',
      'Quelles données avez-vous sur moi ?',
      'Comment télécharger mes données ?',
    ],
  },
];

// Typed variants of the same request. The chip sends the exact sentence, but
// somebody who types "installer l'appli sur mon téléphone" is asking for the
// same thing and must not be told the assistant does not understand.
const ASKS_ABOUT_INSTALL = /\b(install|t[ée]l[ée]charg)\w*\b.*\b(appli|app|leroutier|t[ée]l[ée]phone|portable|mobile|iphone|android|[ée]cran)\b/i;

// What to offer once the server tells us which intent it just answered. Keyed
// by that intent, so the next step follows the conversation instead of
// repeating the opening menu.
const FOLLOW_UPS = {
  trip_search: ['Quel est le prix de Cotonou vers Parakou ?', 'Comment annuler une réservation ?'],
  fare_lookup: ['Quels départs depuis Cotonou ?', 'Statut de ma réservation'],
  booking_status: ['Où est mon bus ?', 'Comment annuler une réservation ?'],
  payment_status: ['Statut de ma réservation', 'Suis-je remboursé si j’annule ?'],
  journey_status: ['Quand arrive mon bus ?', 'Aide et contact'],
  eta: ['Où est mon bus ?', 'Aide et contact'],
  parcel_tracking: ['Comment retirer un colis ?', 'Comment envoyer un colis ?'],
  cancellation_policy: ['Suis-je remboursé si j’annule ?', 'Statut de ma réservation'],
  refund_policy: ['Comment annuler une réservation ?', 'Aide et contact'],
  privacy_summary: ['Comment télécharger mes données ?', 'Aide et contact'],
  data_export: ['Quelles données avez-vous sur moi ?', 'Aide et contact'],
  account_deletion: ['Quelles données avez-vous sur moi ?', 'Aide et contact'],
  support: ['Quels départs depuis Cotonou ?', INSTALL_QUESTION],
  // After installing, the next useful thing is using it.
  install_app: ['Quels départs depuis Cotonou ?', 'Comment envoyer un colis ?', 'Aide et contact'],
};
const DEFAULT_FOLLOW_UPS = ['Quels départs depuis Cotonou ?', 'Où en est mon colis ?', 'Aide et contact'];

/** A stable id per message, so React never re-keys a thread by position. */
let seq = 0;
const nextId = () => `m${++seq}`;
const welcomeThread = () => [{ id: nextId(), from: 'assistant', text: WELCOME }];

function Message({ text = '', from, busy = false, failed = false, onRetry }) {
  return <div className={from === 'user' ? 'assistant-msg user' : 'assistant-msg'}>
    <span className="small muted">{from === 'user' ? 'Vous' : 'LeRoutier'}</span>
    {busy ? <p role="status"><span className="assistant-typing" aria-hidden="true"><i/><i/><i/></span>LeRoutier cherche dans les services publiés…</p>
      : failed ? <p role="alert">La réponse n’a pas abouti. <button className="btn btn-soft" onClick={onRetry}>Réessayer</button></p>
        : <p>{text}</p>}
  </div>;
}

function Suggestions({ groups, onPick, disabled }) {
  return <div className="assistant-suggestions">
    {groups.map(group => <div key={group.title} className="assistant-suggestion-group">
      <h3 className="small muted">{group.title}</h3>
      <div className="assistant-chips">
        {group.items.map(item => <button key={item} type="button" className="chip" disabled={disabled}
          onClick={() => onPick(item)}>{item}</button>)}
      </div>
    </div>)}
  </div>;
}

export function Assistant() {
  const { request, online, authLoading } = useSession();
  const [open, setOpen] = useState(false);
  /** @type {[{id:string,from:string,text?:string,busy?:boolean,failed?:boolean,retry?:string}[], Function]} */
  const [messages, setMessages] = useState(welcomeThread);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastIntent, setLastIntent] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const sessionId = useRef(crypto.randomUUID());
  const panel = useRef(null);
  const opener = useRef(null);
  const input = useRef(null);
  const thread = useRef(null);

  const started = messages.length > 1;

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
        const nodes = [...(panel.current?.querySelectorAll('button, input') ?? [])].filter(n => !n.disabled);
        if (!nodes.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Follow the conversation as it grows. A thread that answers below the fold
  // looks like it did nothing.
  useEffect(() => { if (open && thread.current) thread.current.scrollTop = thread.current.scrollHeight; }, [messages, open]);

  /** Ask the server and settle one assistant bubble, addressed by its own id. */
  const resolve = useCallback(async (bubbleId, message) => {
    setBusy(true);
    try {
      const reply = await request('/assistant', { method: 'POST', body: { sessionId: sessionId.current, message } });
      setLastIntent(reply.intent ?? null);
      setMessages(m => m.map(x => x.id === bubbleId ? { id: bubbleId, from: 'assistant', text: reply.reply } : x));
    } catch {
      setMessages(m => m.map(x => x.id === bubbleId ? { id: bubbleId, from: 'assistant', failed: true, retry: message } : x));
    } finally { setBusy(false); }
  }, [request]);

  /**
   * Install, answered locally and immediately.
   *
   * On Chromium this opens the browser's own install dialog. That call has to
   * happen inside the gesture that started it, so nothing is awaited before
   * it: the two bubbles are queued synchronously, then the dialog opens. A
   * dismissal is not a dead end — the manual steps follow, so somebody who
   * tapped by accident still knows how to finish later.
   */
  const answerInstall = useCallback(async () => {
    const ask = nextId(), reply = nextId();
    setMessages(m => [...m, { id: ask, from: 'user', text: INSTALL_QUESTION },
      { id: reply, from: 'assistant', busy: true }]);
    const steps = installSteps();
    let text;
    if (isInstalled()) text = steps.text;
    else if (canPrompt()) {
      const outcome = await promptInstall();
      text = outcome === 'installed'
        ? 'C’est fait. LeRoutier est installé : vous le trouverez avec vos autres applications, et il s’ouvrira en plein écran sans barre de navigateur.'
        : outcome === 'dismissed'
          ? `Installation annulée, aucun problème. Pour la relancer plus tard : ${installSteps().text}`
          : `${INSTALL_VALUE} ${installSteps().text}`;
    } else text = `${INSTALL_VALUE} ${steps.text}`;
    setMessages(m => m.map(x => x.id === reply ? { id: reply, from: 'assistant', text } : x));
    setLastIntent('install_app');
    setShowAll(false);
  }, []);

  const send = useCallback(async text => {
    const message = String(text ?? '').trim();
    // Before the online guard on purpose: installing is a local act and works
    // perfectly with no network.
    if (message === INSTALL_QUESTION || ASKS_ABOUT_INSTALL.test(message)) {
      if (busy) return;
      setDraft('');
      await answerInstall();
      return;
    }
    if (!message || busy || !online) return;
    setDraft('');
    setShowAll(false);
    // The bubble is addressed by its own id, never by an index computed from a
    // stale render: that arithmetic was one past the end, so the answer was
    // appended and every “cherche…” bubble stayed in the thread under its own reply.
    const pending = nextId();
    setMessages(m => [...m, { id: nextId(), from: 'user', text: message }, { id: pending, from: 'assistant', busy: true }]);
    await resolve(pending, message);
  }, [busy, online, resolve, answerInstall]);

  // Retrying reuses the failed bubble. The user asked once, so the thread
  // shows one question — not their words repeated under a stale error.
  const retry = useCallback(async bubble => {
    if (!bubble?.retry || busy || !online) return;
    setMessages(m => m.map(x => x.id === bubble.id ? { id: bubble.id, from: 'assistant', busy: true } : x));
    await resolve(bubble.id, bubble.retry);
  }, [busy, online, resolve]);

  function reset() {
    sessionId.current = crypto.randomUUID();
    setMessages(welcomeThread());
    setLastIntent(null);
    setShowAll(false);
    setDraft('');
    input.current?.focus();
  }

  // Before the first question, the full menu. Afterwards, the two or three
  // questions that actually follow from the answer — with the full menu one
  // tap away rather than gone.
  const followUps = useMemo(() => (lastIntent && FOLLOW_UPS[lastIntent]) || DEFAULT_FOLLOW_UPS, [lastIntent]);

  if (!open) return null;
  return <section ref={panel} className="assistant-panel" role="dialog" aria-modal="true" aria-label="Assistant LeRoutier">
    <header className="between">
      <h2><MessagesSquare size={16} aria-hidden="true"/>Assistant LeRoutier</h2>
      <div className="controls">
        {started && <button className="btn btn-soft" aria-label="Nouvelle conversation" title="Nouvelle conversation"
          onClick={reset}><RotateCcw size={15} aria-hidden="true"/></button>}
        <button className="btn btn-soft" aria-label="Fermer l’assistant" onClick={() => { setOpen(false); opener.current?.focus(); }}>
          <X size={16} aria-hidden="true"/></button>
      </div>
    </header>
    {authLoading ? <p role="status" className="small muted assistant-note">Vérification de votre identité…</p> : null}
    <div ref={thread} className="assistant-thread" aria-live="polite" role="log" aria-label="Conversation">
      {messages.map(m => <Message key={m.id} {...m} onRetry={() => retry(m)}/>)}

      {/* Opening menu: what this assistant is for, grouped. */}
      {!started && !busy && <Suggestions groups={SUGGESTION_GROUPS} onPick={send} disabled={!online}/>}

      {/* After an answer: the next reasonable question, never a dead end. */}
      {started && !busy && <div className="assistant-followups">
        <div className="assistant-chips">
          {followUps.map(item => <button key={item} type="button" className="chip" disabled={!online}
            onClick={() => send(item)}>{item}</button>)}
          <button type="button" className="chip chip-ghost" aria-expanded={showAll}
            onClick={() => setShowAll(v => !v)}><Sparkles size={13} aria-hidden="true"/>{showAll ? 'Masquer les suggestions' : 'Autres questions'}</button>
        </div>
        {showAll && <Suggestions groups={SUGGESTION_GROUPS} onPick={send} disabled={!online}/>}
      </div>}
    </div>
    <form className="assistant-input" onSubmit={e => { e.preventDefault(); send(draft); }}>
      <input ref={input} className="control" value={draft} onChange={e => setDraft(e.target.value)}
        placeholder="Votre question…" maxLength={1000} disabled={busy || !online} aria-label="Votre message à l’assistant"/>
      <button className="btn btn-primary" type="submit" disabled={busy || !online || !draft.trim()} aria-label="Envoyer">
        <Send size={16} aria-hidden="true"/></button>
    </form>
    {!online && <p role="status" className="small muted assistant-note">Hors ligne : l’assistant répondra à la reconnexion.</p>}
  </section>;
}
