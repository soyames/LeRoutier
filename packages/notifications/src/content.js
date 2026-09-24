/**
 * The one human route into LeRoutier, and the only address a message may ask
 * somebody to write to.
 *
 * Transactional mail is sent from noreply@leroutier.app, which cannot receive
 * anything: leroutier.app publishes no MX record, so a reply is not merely
 * ignored — it fails at the sender's own provider, quietly, while the
 * passenger believes they have asked for help. Every message therefore names
 * this address instead of inviting a reply.
 */
export const SUPPORT_EMAIL = 'leroutierbj@gmail.com';

/** Said on every message, because the sending address cannot receive one. */
const REPLY_NOTICE = 'Cet e-mail est envoyé automatiquement : les réponses à cette adresse ne sont pas lues. '
  + `Pour une aide humaine, écrivez à ${SUPPORT_EMAIL} avec votre référence.`;

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const when = value => value ? new Intl.DateTimeFormat('fr-BJ', { dateStyle:'long',timeStyle:'short',timeZone:'Africa/Porto-Novo' }).format(new Date(value)) : 'Horaire à confirmer auprès du transporteur';
const amount = value => new Intl.NumberFormat('fr-BJ').format(value) + ' FCFA';
export function confirmationEmail(b) {
  const url = 'https://leroutier.app/tickets/' + encodeURIComponent(b.id);
  const rows = [['Référence', b.id.toUpperCase()], ['Voyageur', b.passenger_name], ['Transporteur', b.operator_name],
    ['Conducteur', b.driver_name || 'Non affecté'], ['Embarquement', [b.departure_city,b.departure_point_name,b.departure_point_landmark].filter(Boolean).join(' · ')],
    ['Départ · heure du Bénin', when(b.departure_at)], ['Descente', [b.arrival_city,b.arrival_point_name].filter(Boolean).join(' · ')],
    ['Arrivée prévue', when(b.arrival_at)], ['Place', `Siège ${b.seat_number} · 1 voyageur`], ['Montant payé', amount(b.paidMinor)],
    ['Remboursement enregistré', amount(b.refundedMinor)]];
  const current = ({confirmed:'Réservation confirmée',boarded:'Voyageur à bord',completed:'Voyage terminé',cancelled:'Réservation annulée',expired:'Réservation expirée'})[b.status] || 'Votre réservation';
  const subject = `LeRoutier · ${current} · ${b.departure_city} → ${b.arrival_city}`;
  const instructions = 'Présentez votre billet sur téléphone ou papier à l’équipage. Consultez votre compte avant de partir pour les dernières informations. Le billet, la facture et les éventuels documents d’annulation restent accessibles depuis votre réservation.';
  return {subject,text:`${subject}\n\n${rows.map(([k,v])=>`${k} : ${v}`).join('\n')}\n\nMes documents : ${url}\n\n${instructions}\nAide : https://leroutier.app/about
${REPLY_NOTICE}`,
    html:`<!doctype html><html lang="fr"><meta charset="utf-8"><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#0f172a"><main style="max-width:620px;margin:24px auto;background:white;padding:28px;border-top:6px solid #d97706"><p style="font-size:26px;font-weight:bold">Le<span style="color:#b45309">Routier</span></p><h1 style="font-size:24px">${escape(current)}</h1><p>${escape(b.departure_city)} → ${escape(b.arrival_city)}</p><table style="width:100%;border-collapse:collapse">${rows.map(([k,v])=>`<tr><th style="text-align:left;vertical-align:top;padding:10px 8px;border-bottom:1px solid #e2e8f0;font-size:12px">${escape(k)}</th><td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;font-size:14px;overflow-wrap:anywhere">${escape(v)}</td></tr>`).join('')}</table><p style="margin:28px 0"><a style="background:#0f172a;color:#fff;padding:14px 20px;text-decoration:none;border-radius:8px" href="${url}">Ouvrir mon billet et mes documents</a></p><p style="font-size:14px;line-height:1.6">${escape(instructions)}</p><p style="font-size:12px;color:#475569">${escape(REPLY_NOTICE)}</p><p style="font-size:12px"><a href="https://leroutier.app/about">Aide LeRoutier</a> · leroutier.app</p></main></body></html>`};
}
export const parcelMessages = {parcel_created:'Envoi enregistré',parcel_accepted:'Colis accepté',parcel_loaded:'Colis chargé',parcel_in_transit:'Colis en route',parcel_arrived:'Colis arrivé',parcel_ready_for_pickup:'Colis prêt au retrait',parcel_collected:'Colis retiré',parcel_cancelled:'Envoi annulé',parcel_delayed:'Colis retardé',parcel_exception:'Un incident concerne votre colis'};

/**
 * The account-verification message.
 *
 * The link is the Firebase email-verification action link (oobCode) generated
 * server-side by the Admin SDK; delivery is Brevo's. The message deliberately
 * says nothing about a password, a token or an account detail, so forwarding
 * it — or it being read by somebody else — discloses nothing.
 */
export function verificationEmail(link) {
  const subject = 'Confirmez votre adresse e-mail LeRoutier';
  const text = `Une création de compte LeRoutier a été demandée avec cette adresse e-mail.\n\n` +
    `Confirmez votre adresse pour activer votre accès :\n${link}\n\n` +
    `Ce lien n’est valable que temporairement. Si vous n’avez pas créé de compte LeRoutier, ignorez simplement cet e-mail.\n\n${REPLY_NOTICE}`;
  const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#0f172a"><main style="max-width:620px;margin:24px auto;background:white;padding:28px;border-top:6px solid #d97706">` +
    `<p style="font-size:26px;font-weight:bold">Le<span style="color:#b45309">Routier</span></p>` +
    `<h1 style="font-size:24px">${escape(subject)}</h1>` +
    `<p style="font-size:14px;line-height:1.6">Une création de compte LeRoutier a été demandée avec cette adresse e-mail. Confirmez votre adresse pour activer votre accès.</p>` +
    `<p style="margin:28px 0"><a style="background:#0f172a;color:#fff;padding:14px 20px;text-decoration:none;border-radius:8px" href="${escape(link)}">Confirmer mon adresse e-mail</a></p>` +
    `<p style="font-size:12px;color:#475569">Ce lien n’est valable que temporairement. Si vous n’avez pas créé de compte LeRoutier, vous pouvez ignorer cet e-mail.</p>` +
    `<p style="font-size:12px;color:#475569">${escape(REPLY_NOTICE)}</p>` +
    `<p style="font-size:12px"><a href="https://leroutier.app/about">Aide LeRoutier</a> · leroutier.app</p></main></body></html>`;
  return { subject, text, html };
}
