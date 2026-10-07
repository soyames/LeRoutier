// Phone country selection for a field that has to reach a real person.
//
// WHY THE LIST IS CURATED RATHER THAN COMPLETE. A phone number a platform cannot
// dial is worse than no number, because somebody believes they gave one. This
// list is the countries LeRoutier actually serves, the neighbours a passenger
// travels to or from, and the places its diaspora calls from — so every entry is
// a country an SMS could plausibly go to, and adding one is a decision rather
// than a data import.
//
// BENIN IS THE DEFAULT because it is the default everywhere else in the product:
// `places.country_code DEFAULT 'BJ'`, the mobility providers' country, the
// payout destinations, and the operators' own registration. A departure from a
// different country overrides it — see `resolvePhoneCountry`.
export const DEFAULT_PHONE_COUNTRY = 'BJ';

/** Ordered with Benin first, then alphabetically by the name people read. */
export const PHONE_COUNTRIES = [
  { code: 'BJ', name: 'Bénin', dial: '229' },
  { code: 'ZA', name: 'Afrique du Sud', dial: '27' },
  { code: 'DE', name: 'Allemagne', dial: '49' },
  { code: 'SA', name: 'Arabie saoudite', dial: '966' },
  { code: 'DZ', name: 'Algérie', dial: '213' },
  { code: 'AO', name: 'Angola', dial: '244' },
  { code: 'BE', name: 'Belgique', dial: '32' },
  { code: 'BF', name: 'Burkina Faso', dial: '226' },
  { code: 'CM', name: 'Cameroun', dial: '237' },
  { code: 'CA', name: 'Canada', dial: '1' },
  { code: 'CF', name: 'Centrafrique', dial: '236' },
  { code: 'CN', name: 'Chine', dial: '86' },
  { code: 'CG', name: 'Congo', dial: '242' },
  { code: 'CI', name: 'Côte d’Ivoire', dial: '225' },
  { code: 'EG', name: 'Égypte', dial: '20' },
  { code: 'AE', name: 'Émirats arabes unis', dial: '971' },
  { code: 'ES', name: 'Espagne', dial: '34' },
  { code: 'US', name: 'États-Unis', dial: '1' },
  { code: 'ET', name: 'Éthiopie', dial: '251' },
  { code: 'FR', name: 'France', dial: '33' },
  { code: 'GA', name: 'Gabon', dial: '241' },
  { code: 'GM', name: 'Gambie', dial: '220' },
  { code: 'GH', name: 'Ghana', dial: '233' },
  { code: 'GN', name: 'Guinée', dial: '224' },
  { code: 'GQ', name: 'Guinée équatoriale', dial: '240' },
  { code: 'GW', name: 'Guinée-Bissau', dial: '245' },
  { code: 'IT', name: 'Italie', dial: '39' },
  { code: 'KE', name: 'Kenya', dial: '254' },
  { code: 'LB', name: 'Liban', dial: '961' },
  { code: 'LR', name: 'Liberia', dial: '231' },
  { code: 'ML', name: 'Mali', dial: '223' },
  { code: 'MA', name: 'Maroc', dial: '212' },
  { code: 'MR', name: 'Mauritanie', dial: '222' },
  { code: 'NE', name: 'Niger', dial: '227' },
  { code: 'NG', name: 'Nigeria', dial: '234' },
  { code: 'PT', name: 'Portugal', dial: '351' },
  { code: 'CD', name: 'République démocratique du Congo', dial: '243' },
  { code: 'GB', name: 'Royaume-Uni', dial: '44' },
  { code: 'SN', name: 'Sénégal', dial: '221' },
  { code: 'SL', name: 'Sierra Leone', dial: '232' },
  { code: 'TD', name: 'Tchad', dial: '235' },
  { code: 'TG', name: 'Togo', dial: '228' },
  { code: 'TN', name: 'Tunisie', dial: '216' },
  { code: 'TR', name: 'Turquie', dial: '90' },
];

const BY_CODE = new Map(PHONE_COUNTRIES.map(country => [country.code, country]));

/** A country by ISO code, falling back to the product's own default. */
export function phoneCountry(code) {
  return BY_CODE.get(String(code ?? '').toUpperCase()) ?? BY_CODE.get(DEFAULT_PHONE_COUNTRY);
}

/**
 * Which country to offer first for a given trip.
 *
 * The departure country is the right default — a passenger boarding in Togo
 * almost always has a Togolese number — and it is a hint, never a lock: the
 * selector shows every country, and the choice is the passenger's.
 */
export function resolvePhoneCountry(departureCountryCode) {
  return phoneCountry(departureCountryCode).code;
}

/**
 * The number as it should be stored and dialled: the dial code, then the digits
 * the passenger typed.
 *
 * Deliberately no national-format guessing. Stripping a leading zero is correct
 * in some countries and wrong in others, and a silently mangled number is a
 * passenger nobody can call about their departure.
 */
export function composePhone(code, nationalNumber) {
  const digits = String(nationalNumber ?? '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  return `+${phoneCountry(code).dial} ${digits}`;
}

/** The digits that are not the dial code, for showing a stored number for editing. */
export function nationalPart(value, code) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  const dial = phoneCountry(code).dial;
  return digits.startsWith(dial) ? digits.slice(dial.length) : digits;
}
