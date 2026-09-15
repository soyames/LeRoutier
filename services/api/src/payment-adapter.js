import { fedapayAdapter } from './fedapay.js';

// Adapter contract (provider-independent; packages/domain and packages/database
// never depend on FedaPay specifics):
//   initiate({paymentId,bookingId,amountMinor,currency,idempotencyKey}) -> {reference,checkoutUrl,metadata}
//   reconcilePayment(payment) -> collection event | null
//   createPayout({payoutRequestId,firstName,lastName,phoneNumber,country,amountMinor,currency,idempotencyKey}) -> {reference,metadata}
//   reconcilePayout(request) -> payout event | null
//   verifyEvent(rawBody,headers) -> {kind:'payment'|'payout',...} | null
// Never take status from clients. Returns null when the provider is not configured.
export function paymentAdapter(config){
  return fedapayAdapter(config);
}
