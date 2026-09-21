import { status, fcfa } from '@leroutier/ui';

const when = value => value ? new Intl.DateTimeFormat('fr-BJ', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Porto-Novo' }).format(new Date(value)) : 'Horaire à confirmer auprès du transporteur';
const compact = value => String(value ?? '').replaceAll('-', '').slice(0, 8).toUpperCase();
const travelNotes = [
  'Présentez le QR ou le code de secours à l’équipage au point d’embarquement indiqué.',
  'Gardez une copie sur votre téléphone avant de partir. L’impression est facultative.',
  'Vérifiez les dernières informations du trajet avant de vous rendre au départ. Gardez vos effets personnels avec vous.',
];
export function ticketDocument(ticket, kind = 'ticket') {
  const b = ticket.document;
  const short = compact(b.id);
  const bookingReference = `LRB-${short}`;
  const documentNumber = kind === 'invoice' ? `LRF-${short}` : kind === 'cancellation' ? `LRA-${short}` : bookingReference;
  const paymentRows = [['Tarif du transport', fcfa(b.amount_minor)], ['Montant payé', fcfa(b.paidMinor)], ['Montant remboursé', fcfa(b.refundedMinor)]];
  const cancellation = b.refundedMinor > 0 ? 'Remboursement enregistré' : b.paidMinor > 0 ? 'Remboursement à examiner — aucun versement confirmé' : 'Aucun paiement encaissé';
  return {
    kind, title: kind === 'invoice' ? 'Facture de transport' : kind === 'cancellation' ? 'Annulation / remboursement' : 'Votre billet de voyage',
    reference: bookingReference, number: documentNumber,
    isTest: b.is_demo, status: status('booking', b.status).label,
    route: `${b.departure_city} → ${b.arrival_city}`,
    sections: [
      { title: 'Voyageur & transporteur', rows: [['Voyageur', b.passenger_name], ['Transporteur', b.operator_name], ['Conducteur', b.driver_name || 'Non affecté'], ['Véhicule', b.registration || 'Non affecté'], ['Réservation du', when(b.created_at)]] },
      { title: 'Votre trajet', rows: [['Ligne', b.route_name], ['Embarquement', [b.departure_point_name, b.departure_point_landmark].filter(Boolean).join(' · ')], ['Départ · heure du Bénin', when(b.departure_at)], ['Descente', [b.arrival_point_name, b.arrival_point_landmark].filter(Boolean).join(' · ')], ['Arrivée prévue · heure du Bénin', when(b.arrival_at)], ['Place / quantité', `Siège ${b.seat_number} · 1 voyageur`]] },
      { title: kind === 'cancellation' ? 'Situation du remboursement' : 'Paiement', rows: [...paymentRows,
        ...(kind === 'cancellation' ? [['Situation', cancellation], ['Dernière mise à jour', when(b.updated_at)]] : []),
        ...b.payments.map(p => [`Paiement ${compact(p.id)}`, `${fcfa(p.amount_minor)} · ${p.status === 'refunded' ? 'Remboursé' : 'Reçu'} · ${when(p.created_at)}`])] },
    ],
    qr: kind === 'ticket' ? ticket.token : null, manualCode: kind === 'ticket' ? ticket.manualCode : null,
    qrHelp: ticket.validForBoarding ? 'À présenter à l’embarquement' : 'Archive du billet · contrôle de validité effectué par LeRoutier',
    notes: kind === 'ticket' ? [...(!ticket.validForBoarding ? ['Billet archivé — ce QR reste celui du document original mais ne permet pas un nouvel embarquement.'] : []), ...travelNotes]
      : kind === 'cancellation' ? ['L’annulation et le remboursement sont deux opérations distinctes. Seuls les montants confirmés figurent comme remboursés.', 'Retrouvez le suivi dans votre compte LeRoutier.']
        : ['Document établi à partir des paiements enregistrés pour ce transport. Conservez-le avec votre réservation.'],
    help: `Aide : leroutier.app/about · Réservation : ${bookingReference}`,
  };
}

export function parcelDocument(p, kind = 'label') {
  return { kind, title: kind === 'label' ? 'Étiquette colis' : 'Reçu de dépôt', reference: p.trackingNumber,
    number: p.trackingNumber, isTest: p.isTest, status: status('parcel', p.status).label,
    route: `${p.origin} → ${p.destination}`,
    sections: [
      { title: 'Expéditeur', rows: [['Nom', p.parties?.sender?.name], ['Téléphone', p.parties?.sender?.phone], ['Dépôt', p.originName]] },
      { title: 'Destinataire', rows: [['Nom', p.parties?.receiver?.name], ['Téléphone', p.parties?.receiver?.phone], ['Retrait', p.destinationName]] },
      { title: 'Prise en charge', rows: [['Transporteur', p.operatorName], ['Service', p.serviceLevel === 'express' ? 'Express' : 'Standard'], ['Pièces / poids', `${p.quantity} pièce(s)${p.weightG ? ` · ${p.weightG} g` : ''}`], ['Paiement', `${p.paymentStatus === 'succeeded' ? 'Payé' : p.paymentStatus === 'partial' ? 'Partiellement payé' : 'À payer'} · ${fcfa(p.paidMinor)} / ${fcfa(p.priceMinor)}`], ['À la charge de', p.paymentResponsibility === 'receiver' ? 'Destinataire' : 'Expéditeur'], ['Manipulation', p.notes || (p.category === 'fragile' ? 'Fragile — manipuler avec soin' : 'Aucune consigne particulière')]] },
    ], qr: p.trackingUrl || `https://leroutier.app/parcels/track?ref=${p.trackingNumber}`, manualCode: p.trackingNumber,
    qrHelp: 'Scanner pour suivre ou saisir la référence', stickerSpace: kind === 'label',
    notes: ['Sans imprimante : montrez ce QR à l’équipage et inscrivez la référence sur le colis.',
      'Enregistrement ≠ prise en charge. Le statut confirme la réception par le transporteur.',
      'Le QR identifie le colis. Le retrait nécessite le code distinct remis après vérification du destinataire.'],
    help: 'Suivi : leroutier.app/parcels/track · Aide : leroutier.app/about',
  };
}
