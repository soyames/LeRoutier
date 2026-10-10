// Legacy commission split retained for parcel transactions. Passenger tickets
// use priceWithServiceFee below: it adds 2% on top of the fare and preserves the
// operator's full published fare.

/** Commission basis points: 500 bp = 5 % of the final customer price. */
export const LEROUTIER_COMMISSION_BP = 500;

/** Customer-facing service fee added to the operator's published fare. */
export const LEROUTIER_SERVICE_FEE_BP = 200;

/**
 * Add the LeRoutier service fee on top of an operator-set fare. The operator
 * keeps the full published fare; payment-provider charges remain separate.
 */
export function priceWithServiceFee(fareMinor, feeBp = LEROUTIER_SERVICE_FEE_BP) {
  if (!Number.isInteger(fareMinor) || fareMinor < 0) throw new Error('Service fee requires a non-negative integer fare.');
  if (!Number.isInteger(feeBp) || feeBp < 0 || feeBp > 10000) throw new Error('Service fee basis points must be 0–10000.');
  const serviceFeeMinor = Math.round((fareMinor * feeBp) / 10000);
  return { fareMinor, serviceFeeMinor, totalMinor: fareMinor + serviceFeeMinor, feeBp };
}

/**
 * Splits a final customer price into LeRoutier commission and operator net.
 * Rounding goes to the nearest FCFA (a half rounds up); net is the remainder,
 * so the identity grossMinor === commissionMinor + netMinor is exact.
 */
export function splitCommission(grossMinor, commissionBp = LEROUTIER_COMMISSION_BP) {
  if (!Number.isInteger(grossMinor) || grossMinor < 0) throw new Error('Commission requires a non-negative integer amount.');
  if (!Number.isInteger(commissionBp) || commissionBp < 0 || commissionBp > 10000) throw new Error('Commission basis points must be 0–10000.');
  const commissionMinor = Math.round((grossMinor * commissionBp) / 10000);
  return { grossMinor, commissionMinor, netMinor: grossMinor - commissionMinor, commissionBp };
}
