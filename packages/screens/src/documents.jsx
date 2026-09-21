import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Download, Printer, Share2, X, FileText } from 'lucide-react';
import { Logo } from '@leroutier/ui';
import { parcelDocument, ticketDocument } from './document-model.js';

// A single document surface across the existing booking, parcel and ops screens.
// Nothing private is placed in localStorage or a public URL.
export function DocumentPreview({ documents, onClose }) {
  const dialog = useRef(null), qr = useRef(null), pdfs = useRef(new Map());
  const [kind, setKind] = useState(documents[0].kind), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [ready, setReady] = useState([]);
  const model = documents.find(d => d.kind === kind) || documents[0];
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current.showModal();
    const urls = pdfs.current;
    return () => { for (const file of urls.values()) URL.revokeObjectURL(file.url); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  // Prepare the file before Share is tapped so mobile retains user activation.
  useEffect(() => {
    let cancelled = false;
    if (pdfs.current.has(model.kind)) { setBusy(false); return; }
    setBusy(true); setError('');
    import('./document-pdf.js').then(({ makeDocumentPdf }) => makeDocumentPdf(model, qr.current?.querySelector('svg')))
      .then(blob => { if (!cancelled) { pdfs.current.set(model.kind, { blob, url: URL.createObjectURL(blob) }); setReady(prev => [...prev, model.kind]); } })
      .catch(() => { if (!cancelled) setError('Le PDF n’a pas pu être préparé. Vous pouvez imprimer cet aperçu ou réessayer en le rouvrant.'); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [model]);
  function download() {
    const pdf = pdfs.current.get(model.kind); if (!pdf) return;
    const a = document.createElement('a'); a.href = pdf.url; a.download = `LeRoutier-${model.kind}-${model.reference}.pdf`; a.click();
  }
  async function share() {
    setError(''); setNotice('');
    const pdf = pdfs.current.get(model.kind); if (!pdf) return;
    const file = new File([pdf.blob], `LeRoutier-${model.kind}-${model.reference}.pdf`, { type: 'application/pdf' });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: model.title });
      else { download(); setNotice('PDF téléchargé. Joignez ce fichier au message de votre choix.'); }
    } catch (e) { if (e.name !== 'AbortError') { download(); setNotice('Partage indisponible. Le PDF a été téléchargé pour être joint à votre message.'); } }
  }
  return createPortal(<dialog ref={dialog} className="document-dialog" aria-label="Mes documents LeRoutier" onCancel={onClose}>
    <div className="document-toolbar stack">
      <div className="between wrap"><strong>Mes documents</strong><button className="btn btn-soft" onClick={onClose} aria-label="Fermer les documents"><X size={18}/>Fermer</button></div>
      <div className="controls" aria-label="Type de document">{documents.map(d => <button key={d.kind} className={model.kind === d.kind ? 'btn btn-primary' : 'btn btn-soft'} aria-pressed={model.kind === d.kind} onClick={() => { setKind(d.kind); setNotice(''); }}><FileText size={16}/>{d.title}</button>)}</div>
      <div className="controls">
        <button className="btn btn-dark" disabled={busy || !ready.includes(model.kind)} onClick={download}><Download size={16}/>{busy ? 'Préparation du PDF…' : 'Télécharger le PDF'}</button>
        <button className="btn btn-soft" onClick={() => window.print()}><Printer size={16}/>Imprimer</button>
        <button className="btn btn-soft" disabled={busy || !ready.includes(model.kind)} onClick={share}><Share2 size={16}/>Partager</button>
      </div>
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    </div>
    <article className={`lr-document document-${model.kind}`}>
      <header className="document-brand"><Logo/><span>leroutier.app</span></header>
      {model.isTest && <p className="document-test">TEST · DOCUMENT DE DÉMONSTRATION · AUCUNE VALEUR COMMERCIALE</p>}
      <div className="document-heading"><span className="eyebrow">{model.title}</span><h1>{model.route}</h1><strong>{model.status}</strong></div>
      <div className="document-reference"><span>Référence</span><strong>{model.reference}</strong><small>{model.number}</small></div>
      {model.qr && <div className="document-qr ticket-qr" ref={qr}><QRCodeSVG value={model.qr} size={196} marginSize={4} level="M"/>
        <strong className="ticket-code">{model.manualCode}</strong><span>{model.qrHelp}</span></div>}
      <div className="document-sections">{model.sections.map(section => <section key={section.title}><h2>{section.title}</h2><dl>{section.rows.map(([label, value], i) => <div key={i}><dt>{label}</dt><dd>{value ?? 'Non renseigné'}</dd></div>)}</dl></section>)}</div>
      {model.stickerSpace && <div className="document-sticker">Espace réservé aux étiquettes du transporteur / relais</div>}
      <section className="document-instructions"><h2>À retenir</h2><ul>{model.notes.map(note => <li key={note}>{note}</li>)}</ul></section>
      <footer>{model.help}</footer>
    </article>
  </dialog>, document.body);
}

export function TicketDocuments({ ticket, onClose }) {
  const b = ticket.document;
  const documents = [ticketDocument(ticket)];
  if (b.paidMinor > 0) documents.push(ticketDocument(ticket, 'invoice'));
  if (b.status === 'cancelled' || b.refundedMinor > 0) documents.push(ticketDocument(ticket, 'cancellation'));
  return <DocumentPreview documents={documents} onClose={onClose}/>;
}
export function ParcelDocuments({ parcel, onClose }) {
  return <DocumentPreview documents={[parcelDocument(parcel), parcelDocument(parcel, 'receipt')]} onClose={onClose}/>;
}
