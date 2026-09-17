# FedaPay webhooks

Canonical webhook URL: `https://api.leroutier.app/api/v1/webhooks/fedapay`
(domain alias of the `le-routier-api` Vercel project). POST-only; the signature
is verified exactly per FedaPay's official scheme before anything correlates
(`services/api/src/fedapay.js`): `X-FEDAPAY-SIGNATURE = t=<seconds>,s=<hmac>`
over `<timestamp>.<rawBody>`, 300 s tolerance, constant-time compare. A bad
signature fails closed (401); a well-signed event that does not correlate to a
LeRoutier record is answered 200 and safely ignored; anomalies are audited to
the outbox. Replays are idempotent (event-id fingerprint guard).

## Event subscription classification

| FedaPay event | Class | Why |
| --- | --- | --- |
| `transaction.approved` | REQUIRED | Confirms bookings and settles the ticket-online ledger entry. |
| `transaction.canceled` | REQUIRED | Releases the hold; the refund review path depends on it. |
| `transaction.refunded` | REQUIRED | Cancels the booking and releases capacity straight from the webhook (added to the allowlist 2026-09; previously only reachable via reconciliation). |
| `transaction.declined` | REQUIRED | Marks the payment failed and releases the hold. |
| `transaction.created` | REQUIRED | Marks the payment pending (idempotent with initiation). |
| `transaction.transferred` | REQUIRED | A successful collection can arrive as transferred instead of approved. |
| `transaction.updated` | REQUIRED | Catch-all status correction; correlates by reference/metadata. |
| `transaction.expired` | UNUSED | Booking holds self-expire inside LeRoutier; no webhook action needed. |
| `transaction.deleted` | UNUSED | Administrative rarity; nothing to do for a deleted provider row. |
| `payout.started` | REQUIRED | Moves the payout request to processing. |
| `payout.sent` | REQUIRED | Marks ledger entries paid only after provider confirmation. |
| `payout.updated` | REQUIRED | Intermediate states (processing, scheduled…). |
| `payout.failed` / `payout.canceled` / `payout.reversed` | REQUIRED (to add) | These release reservations and reverse ledger state; the backend maps them but they are not currently subscribed. |
| `payout.created` | SUPPORTED_BUT_OPTIONAL | The local record is authoritative at creation; reconciliation covers the rest. |
| `account.*`, `customer.*`, `payment_request.*` | UNUSED | No LeRoutier correlation marker exists on these entities; they are safely ignored. |

**Minimum safe subscribed set**: the seven `transaction.*` REQUIRED rows above
plus `payout.started`, `payout.sent`, `payout.updated`, `payout.failed`,
`payout.canceled`, `payout.reversed`. The unused families may stay subscribed
(they are ignored without cost) or be removed to reduce noise. Subscription
changes are owner actions in the FedaPay dashboard — never changed blindly.

## Return URLs

Customer-facing return URLs (when configured) must use the canonical frontend
`https://leroutier.app`. The server webhook stays on the API hostname. Nothing
in the repository hardcodes a return URL today: the checkout token flow lets
FedaPay host the payment page.

## Constraints

Never rotate the webhook secret without a coordinated change on both sides;
never make a real payment or payout to verify — the signature, replay and
state-machine tests cover the contract without money.
