// Every word a USSD caller reads.
//
// Kept out of the flow logic so a translation is a change to this file alone,
// and so nobody has to read a state machine to find out what the product says.
//
// The audience decides the register: a feature phone, a small screen, often
// bright sunlight, sometimes a reader who is not confident. So: short lines,
// numbered choices in the same place every time, no jargon, no internal codes.
// "Réserver", never "Créer une réservation transactionnelle".

export const LOCALES = ['fr'];
export const DEFAULT_LOCALE = 'fr';

/** FCFA has no minor unit in practice; a price is never shown with decimals. */
export const fcfa = minor => {
  const grouped = Math.round(Number(minor) || 0).toLocaleString("fr-FR");
  // French grouping inserts narrow and non-breaking spaces, which some
  // handsets render as a box. Matched by code point rather than by a literal
  // or an escape, so the character is unambiguous to anyone reading this.
  const SPACES = new Set([0x20, 0xa0, 0x202f, 0x2009]);
  let out = "";
  for (const char of grouped) out += SPACES.has(char.codePointAt(0)) ? " " : char;
  return out + " F";
};

/** 24-hour, zero-padded: unambiguous, and two characters shorter than 07:00 AM. */
export const clock = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}` : '--:--';
};

export const shortDate = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}` : '--/--';
};

const fr = {
  'menu.title': 'Bienvenue sur LeRoutier',
  'menu.1': '1. Trouver un trajet',
  'menu.2': '2. Mes réservations',
  'menu.3': '3. Suivre un colis',
  'menu.4': '4. Statut de mon voyage',
  'menu.5': '5. Aide',
  'menu.6': '6. Langue',

  'nav.back': '0. Retour',
  'nav.cancel': '00. Quitter',
  'nav.more': '#. Suivant',
  'nav.previous': '*. Précédent',
  'nav.choose': 'Votre choix:',
  'nav.invalid': 'Choix invalide.',
  'nav.goodbye': 'Merci d’avoir utilisé LeRoutier.',
  'nav.cancelled': 'Session annulée.',

  'search.origin': 'Départ:',
  'search.destination': 'Arrivée:',
  'search.date.title': 'Quand voulez-vous partir ?',
  'search.date.today': "1. Aujourd'hui",
  'search.date.tomorrow': '2. Demain',
  'search.searching': 'Recherche en cours…',
  'search.none': 'Aucun départ trouvé pour ce trajet.',
  'search.none.hint': 'Essayez une autre date.',
  'search.results': 'Départs:',
  'search.sameStop': 'Le départ et l’arrivée doivent être différents.',

  'book.title': 'Réserver',
  'book.passengers': 'Nombre de places (1-5):',
  'book.summary': 'Récapitulatif:',
  'book.confirm': '1. Confirmer',
  'book.cancel': '2. Annuler',
  'book.creating': 'Réservation en cours…',
  'book.created': 'Réservation enregistrée.',
  'book.reference': 'Référence:',
  'book.signInRequired': 'Ce numéro n’a pas encore de compte LeRoutier.',
  'book.signInHint': 'Créez votre compte sur le-routier.vercel.app puis revenez ici.',
  'book.unverified': 'Réservation indisponible sur ce canal pour le moment.',
  'book.unverifiedHint': 'Utilisez le-routier.vercel.app pour réserver.',

  'pay.title': 'Paiement',
  'pay.amount': 'Montant:',
  'pay.now': '1. Payer maintenant',
  'pay.later': '2. Payer plus tard',
  'pay.initiated': 'Paiement en attente.',
  'pay.initiatedHint': 'Vous recevrez une confirmation.',
  'pay.unavailable': 'Paiement momentanément indisponible.',
  'pay.laterHint': 'Votre place est réservée un court instant.',

  'bookings.title': 'Mes réservations',
  'bookings.none': 'Aucune réservation trouvée.',
  'bookings.noneHint': 'Trouvez un trajet depuis le menu principal.',

  'parcel.prompt': 'Numéro de suivi du colis:',
  'parcel.promptHint': 'Exemple: LRP-1A2B3C4D',
  'parcel.notFound': 'Référence introuvable.',
  'parcel.title': 'Colis',
  'parcel.route': 'Trajet:',
  'parcel.status': 'Statut:',
  'parcel.updated': 'Mise à jour:',

  'journey.title': 'Statut du voyage',
  'journey.prompt': 'Référence de réservation:',
  'journey.notFound': 'Réservation introuvable.',
  'journey.departure': 'Départ:',
  'journey.status': 'Statut:',
  'journey.nextStop': 'Prochain arrêt:',
  'journey.eta': 'Arrivée estimée:',
  'journey.etaUnavailable': 'Estimation indisponible.',
  'journey.boardingPoint': 'Embarquement:',

  'help.title': 'Aide LeRoutier',
  'help.1': '1. Réserver un trajet',
  'help.2': '2. Paiement',
  'help.3': '3. Colis',
  'help.4': '4. Contact',
  'help.booking': 'Choisissez Trouver un trajet, puis le départ, l’arrivée et la date. Confirmez pour réserver.',
  'help.payment': 'Le paiement se fait par mobile money. Votre place est confirmée après validation du paiement.',
  'help.parcel': 'Choisissez Suivre un colis et saisissez la référence reçue à l’expédition.',
  'help.contact': 'Assistance: le-routier.vercel.app',

  'locale.title': 'Langue / Language',
  'locale.fr': '1. Français',
  'locale.changed': 'Langue enregistrée.',
  'locale.unavailable': 'Seul le français est disponible pour le moment.',

  // Domain errors, in the caller's language. An internal code is never shown.
  'error.generic': 'Service momentanément indisponible.',
  'error.retry': 'Veuillez réessayer plus tard.',
  'error.expired': 'Session expirée.',
  'error.expiredHint': 'Composez à nouveau pour recommencer.',
  'error.tooMany': 'Trop de tentatives. Patientez un instant.',
  'error.SOLD_OUT': 'Ce trajet est complet.',
  'error.NOT_FOUND': 'Référence introuvable.',
  'error.FORBIDDEN': 'Action non autorisée avec ce compte.',
  'error.PROFILE_REQUIRED': 'Complétez votre profil avant de réserver.',
  'error.ACCOUNT_DISABLED': 'Ce compte est désactivé.',
  'error.RATE_LIMITED': 'Trop de tentatives. Patientez un instant.',
  'error.INVALID_JOURNEY': 'Trajet invalide.',
  'error.PAYMENT_UNAVAILABLE': 'Paiement momentanément indisponible.',
  'error.AUTH_UNAVAILABLE': 'Connexion indisponible pour le moment.',
};

const CATALOGUES = { fr };

/**
 * A missing key returns the key itself rather than an empty screen: a caller
 * seeing `book.title` is a bug report; a caller seeing nothing is a mystery.
 */
export function translator(locale = DEFAULT_LOCALE) {
  const catalogue = CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE];
  return (key, values = {}) => {
    const template = catalogue[key] ?? CATALOGUES[DEFAULT_LOCALE][key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, name) => (values[name] ?? ''));
  };
}

/** Booking and service states, as a passenger would say them. */
export const BOOKING_STATUS = {
  held: 'En attente de paiement', confirmed: 'Confirmée', boarded: 'À bord',
  completed: 'Terminée', cancelled: 'Annulée', expired: 'Expirée',
};

export const PAYMENT_STATUS = {
  pending: 'En attente', succeeded: 'Payé', failed: 'Échoué',
  cancelled: 'Annulé', refunded: 'Remboursé', expired: 'Expiré',
};

export const SERVICE_STATUS = {
  scheduled: 'À l’heure', active: 'En route', disrupted: 'Perturbé',
  completed: 'Arrivé', cancelled: 'Annulé',
};

/** Parcel states, kept to what a sender or receiver needs to know. */
export const PARCEL_STATUS = {
  created: 'Enregistré', accepted: 'Accepté', manifested: 'Manifesté',
  loaded: 'Chargé', in_transit: 'En transit', arrived: 'Arrivé',
  ready_for_pickup: 'Prêt au retrait', collected: 'Retiré',
  cancelled: 'Annulé', rejected: 'Refusé', held: 'En attente de traitement',
  damaged: 'Incident', lost: 'Incident', return_requested: 'Retour demandé', returned: 'Retourné',
};
