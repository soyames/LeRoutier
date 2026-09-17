// Commercial model: integer-money commission split.
//
// The fare an operator publishes IS the final customer price. LeRoutier's
// commission comes out of that amount — it is never added on top — and the
// operator receives the remainder:
//
//   published 7 500 FCFA  →  passenger pays 7 500 FCFA
//   commission (5 %)     =  375 FCFA
//   operator net         =  7 125 FCFA
//
// All arithmetic is integer-based; gross = commission + net always holds by
// construction. One constant, one function: every UI preview, settlement
// credit and test uses this same implementation.

/** Commission basis points: 500 bp = 5 % of the final customer price. */
export const LEROUTIER_COMMISSION_BP = 500;

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
