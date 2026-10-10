import { invariant } from './index.js';

// 00:00 on May 1 in Africa/Porto-Novo (UTC+1, no daylight saving).
export const OPERATOR_PAID_FROM = '2027-04-30T23:00:00.000Z';
export const SUBSCRIPTION_PRICES = {
  independent: { monthly: 10000, halfYear: 60000, yearly: 120000 },
  company: { monthly: 30000, halfYear: 180000, yearly: 360000 },
};
/** @param {Date|string} now */
export const subscriptionFree = (now = new Date()) => new Date(now).getTime() < Date.parse(OPERATOR_PAID_FROM);
export function subscriptionPrice(type, period) {
  const amount = SUBSCRIPTION_PRICES[type]?.[period];
  invariant(Number.isInteger(amount), 'INVALID_PLAN', 'Choisissez une période de facturation valide.');
  return amount;
}
export function subscriptionEnd(start, period) {
  const months = { monthly: 1, halfYear: 6, yearly: 12 }[period];
  invariant(months, 'INVALID_PLAN', 'Période invalide.');
  const date = new Date(new Date(start).getTime() + 3600000), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return new Date(date.getTime() - 3600000).toISOString();
}
/** @param {Date|string} now */
export function priorBeninMonth(now = new Date()) {
  const local = new Date(new Date(now).getTime() + 3600000);
  const year = local.getUTCFullYear(), month = local.getUTCMonth();
  return { start: new Date(Date.UTC(year, month - 1, 1) - 3600000).toISOString(),
    end: new Date(Date.UTC(year, month, 1) - 3600000).toISOString() };
}
