import { jsPDF } from 'jspdf';
import fontUrl from './fonts/NotoSans-Regular.ttf?url';

let font;
async function loadFont() {
  if (!font) {
    const r = await fetch(fontUrl);
    if (!r.ok) throw new Error('Document font unavailable');
    const bytes = new Uint8Array(await r.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    font = btoa(binary);
  }
  return font;
}
async function qrImage(svg) {
  if (!svg) return null;
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  try {
    const img = new Image(); img.src = url; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 700;
    canvas.getContext('2d').drawImage(img, 0, 0, 700, 700);
    return canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

// Vector text with an embedded Unicode font; the QR alone is rasterized at
// print resolution. No screenshot of the application and no third-party renderer.
export async function makeDocumentPdf(model, svg) {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  pdf.addFileToVFS('NotoSans.ttf', await loadFont()); pdf.addFont('NotoSans.ttf', 'NotoSans', 'normal'); pdf.setFont('NotoSans');
  pdf.setProperties({ title: `${model.title} · ${model.reference}`, author: 'LeRoutier', subject: model.number });
  let y = 20;
  const ink = () => pdf.setTextColor(15, 23, 42);
  const header = () => {
    pdf.setFillColor(217, 119, 6); pdf.rect(16, 12, 4, 12, 'F');
    ink(); pdf.setFontSize(22); pdf.text('LeRoutier', 24, 22);
    pdf.setFontSize(9); pdf.text('leroutier.app', 194, 21, { align: 'right' }); y = 34;
  };
  function room(height) { if (y + height > 273) { pdf.addPage(); header(); } }
  function text(value, size = 10, width = 178, x = 16) {
    pdf.setFontSize(size);
    const lines = pdf.splitTextToSize(String(value ?? 'Non renseigné').replaceAll('→', ' > '), width);
    const leading = size * .47;
    for (const line of lines) { room(leading); ink(); pdf.text(line, x, y); y += leading; }
    y += 2;
  }
  header();
  if (model.isTest) text('TEST · DOCUMENT DE DÉMONSTRATION · AUCUNE VALEUR COMMERCIALE', 9);
  const headingWidth = model.qr ? 128 : 178;
  text(model.title, 12, headingWidth); text(model.route, 20, headingWidth); text(model.status, 10, headingWidth);
  text('Référence : ' + model.reference, 9, headingWidth);
  if (model.kind !== 'ticket' && model.number !== model.reference) text(model.number, 8, headingWidth);
  if (model.qr) {
    const img = await qrImage(svg);
    if (!img) throw new Error('Document QR unavailable');
    pdf.addImage(img, 'PNG', 151, 34, 43, 43);
    text(model.manualCode, 11, 128); text(model.qrHelp, 8, 128); y = Math.max(y, 82);
  }
  for (const section of model.sections) {
    room(20); pdf.setDrawColor(217, 119, 6); pdf.line(16, y, 194, y); y += 5;
    text(section.title, 11);
    for (const [label, value] of section.rows) {
      pdf.setFontSize(9);
      const labels = pdf.splitTextToSize(String(label), 55), values = pdf.splitTextToSize(String(value ?? 'Non renseigné'), 118);
      const height = Math.max(labels.length, values.length) * 4 + 1.5;
      // Long handling instructions may span pages; never crop them.
      if (height > 210) { text(label, 9); text(value, 10); continue; }
      room(height); pdf.setTextColor(71, 85, 105); pdf.text(labels, 16, y);
      ink(); pdf.text(values, 76, y); y += height;
    }
    y += 2;
  }
  if (model.stickerSpace) { room(29); pdf.setDrawColor(148, 163, 184); pdf.rect(16, y, 178, 24); y += 8; text('Espace réservé aux étiquettes du transporteur / relais', 9, 165, 21); y += 17; }
  room(20); text('À retenir', 12); for (const note of model.notes) text('• ' + note, 9);
  for (let i = 1; i <= pdf.getNumberOfPages(); i++) {
    pdf.setPage(i); pdf.setFontSize(8); pdf.setTextColor(71, 85, 105);
    pdf.text(pdf.splitTextToSize(model.help, 160), 16, 282);
    pdf.text(`${i} / ${pdf.getNumberOfPages()}`, 194, 289, { align: 'right' });
  }
  return pdf.output('blob');
}
