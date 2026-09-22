// Shared presentation vocabulary.
//
// Every screen reads statuses, money, times and references the same way, so an
// equivalent state never looks different in two places. Backend enum names
// (`ready_for_pickup`, `pending_verification`, `held`) are translated here and
// nowhere else — no screen should ever render a raw domain value.

export const TONES = { success: 'success', warning: 'warning', danger: 'danger', neutral: 'neutral' };

// Booking lifecycle, as the passenger experiences it.
const BOOKING = {
  held: ['À payer', 'warning'],
  confirmed: ['Confirmé', 'success'],
  boarded: ['À bord', 'success'],
  completed: ['Terminé', 'neutral'],
  cancelled: ['Annulé', 'danger'],
  expired: ['Expiré', 'danger'],
};

// Service lifecycle, as crew and operations experience it.
const SERVICE = {
  scheduled: ['Programmé', 'neutral'],
  active: ['En cours', 'success'],
  disrupted: ['Perturbé', 'warning'],
  completed: ['Terminé', 'neutral'],
  cancelled: ['Annulé', 'danger'],
};

const PARCEL = {
  created: ['Créé', 'neutral'],
  accepted: ['Accepté', 'neutral'],
  manifested: ['Affecté au départ', 'neutral'],
  loaded: ['Chargé', 'neutral'],
  in_transit: ['En route', 'neutral'],
  arrived: ['Arrivé', 'neutral'],
  ready_for_pickup: ['Prêt à retirer', 'warning'],
  collected: ['Retiré', 'success'],
  cancelled: ['Annulé', 'neutral'],
  rejected: ['Refusé', 'danger'],
  held: ['Retenu', 'warning'],
  damaged: ['Endommagé', 'danger'],
  lost: ['Perdu', 'danger'],
  return_requested: ['Retour demandé', 'warning'],
  returned: ['Retourné', 'neutral'],
};

const PAYMENT = {
  none: ['Paiement requis', 'warning'],
  pending: ['Paiement en cours', 'neutral'],
  succeeded: ['Paiement reçu', 'success'],
  failed: ['Paiement refusé', 'danger'],
  cancelled: ['Paiement annulé', 'danger'],
  refunded: ['Remboursé', 'neutral'],
};

const PAYOUT = {
  requested: ['Demandé', 'neutral'],
  processing: ['En cours', 'warning'],
  paid: ['Versé', 'success'],
  failed: ['Échoué', 'danger'],
  cancelled: ['Annulé', 'neutral'],
  reversed: ['Annulé (reversé)', 'danger'],
};

// Operator verification, phrased for the person waiting on it.
const VERIFICATION = {
  draft: ['Dossier à compléter', 'warning'],
  pending_verification: ['Vérification en cours', 'warning'],
  verified: ['Compte vérifié', 'success'],
  rejected: ['Dossier refusé', 'danger'],
  suspended: ['Compte suspendu', 'danger'],
};

const SETS = { booking: BOOKING, service: SERVICE, parcel: PARCEL, payment: PAYMENT, payout: PAYOUT, verification: VERIFICATION };

/** @param {keyof SETS} kind @param {string|undefined|null} value */
export function status(kind, value) {
  const entry = SETS[kind]?.[value ?? ''];
  // An unmapped value is shown neutrally rather than leaking the enum name.
  if (!entry) return { label: '–', tone: 'neutral', known: false };
  return { label: entry[0], tone: entry[1], known: true };
}

export const fcfa = minor => `${Number(minor ?? 0).toLocaleString('fr-FR')} FCFA`;

/** @type {Intl.DateTimeFormatOptions} */
const TIME = { hour: '2-digit', minute: '2-digit' };
export const time = value => (value ? new Date(value).toLocaleTimeString('fr-FR', TIME) : null);
export const dayShort = value => (value ? new Date(value).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) : null);
export const dayLong = value => (value ? new Date(value).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : null);
export const dateTime = value => (value ? `${dayShort(value)} · ${time(value)}` : null);

/** Duration between two instants, or null when the arrival is not scheduled. */
export function duration(from, to) {
  if (!from || !to) return null;
  const minutes = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}` : `${m} min`;
}

/** Time remaining until an instant, for countdowns. Null once it has passed. */
export function untilLabel(value, now = Date.now()) {
  if (!value) return null;
  const minutes = Math.round((new Date(value).getTime() - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 60) return `dans ${minutes} min`;
  const h = Math.floor(minutes / 60);
  return h < 24 ? `dans ${h} h${minutes % 60 ? ` ${minutes % 60}` : ''}` : `dans ${Math.round(h / 24)} j`;
}

// A booking id is a UUID. Passengers and agents quote a short prefix; it is a
// real prefix of the stored identifier, never an invented code.
export const reference = id => (typeof id === 'string' ? id.replace(/-/g, '').slice(0, 8).toUpperCase() : '');

// Map link for a point that actually has coordinates. Coordinates themselves
// are never the interface — this is.
export function mapLink(latitude, longitude, zoom = 17) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=${zoom}/${latitude}/${longitude}`;
}

/** "Gare de Jonquet — en face du marché", skipping whatever is missing. */
export function placeLabel(name, landmark) {
  return [name, landmark].filter(Boolean).join(' · ') || null;
}
