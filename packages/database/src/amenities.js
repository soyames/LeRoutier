/**
 * Vehicle amenities: one list, shared by the operator form, the API and the
 * passenger UI.
 *
 * These are claims an operator makes about its own coach, not facts LeRoutier
 * verifies. The wording reflects that everywhere they are shown: a passenger
 * reads "l'opérateur annonce", never a LeRoutier guarantee. We have no way to
 * check whether the air conditioning worked this morning, and pretending
 * otherwise is how a booking platform loses the trust it is selling.
 *
 * The set is deliberately small and concrete — things an intercity traveller
 * in Benin actually chooses between on a Cotonou–Parakou run, not a marketing
 * taxonomy.
 */
import { invariant } from '@leroutier/domain';

/** @type {Record<string,{label:string,short:string}>} */
export const AMENITIES = {
  air_conditioning: { label: 'Climatisation', short: 'Clim' },
  wifi: { label: 'Wi-Fi à bord', short: 'Wi-Fi' },
  usb_power: { label: 'Prises USB', short: 'USB' },
  reclining_seats: { label: 'Sièges inclinables', short: 'Inclinable' },
  luggage_hold: { label: 'Soute à bagages', short: 'Soute' },
  drinking_water: { label: 'Eau offerte', short: 'Eau' },
  onboard_toilet: { label: 'Toilettes à bord', short: 'Toilettes' },
  tv: { label: 'Télévision', short: 'TV' },
};

export const AMENITY_KEYS = Object.keys(AMENITIES);

/**
 * Validate an operator-supplied amenity list.
 *
 * Unknown values are refused rather than dropped: silently discarding an
 * operator's input would have them believe they had advertised something they
 * had not. Duplicates are collapsed and order is normalized so two identical
 * declarations store identically.
 */
export function normalizeAmenities(value) {
  if (value === undefined || value === null) return [];
  invariant(Array.isArray(value), 'INVALID_AMENITIES', 'La liste des équipements est invalide.');
  invariant(value.length <= AMENITY_KEYS.length, 'INVALID_AMENITIES', 'Trop d’équipements déclarés.');
  const seen = new Set();
  for (const entry of value) {
    invariant(typeof entry === 'string' && Object.hasOwn(AMENITIES, entry),
      'INVALID_AMENITIES', 'Équipement inconnu : ' + String(entry).slice(0, 40));
    seen.add(entry);
  }
  // Stored in the canonical order of the catalogue, so a vehicle's list reads
  // the same way everywhere it is displayed.
  return AMENITY_KEYS.filter(key => seen.has(key));
}

/** The public projection: a key the UI can render, with its own wording. */
export const describeAmenities = keys => (keys ?? [])
  .filter(key => Object.hasOwn(AMENITIES, key))
  .map(key => ({ key, label: AMENITIES[key].label, short: AMENITIES[key].short }));
