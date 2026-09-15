# Driver Earnings & Payouts

## Ledger first, formula later

Driver earnings are recorded in a proper ledger (`driver_earnings`, integer
minor units only) with:

- driver and (where relevant) operator;
- source and reference of the earning (e.g. a completed trip);
- gross earning, deductions/commission if defined, and net payable;
- currency, `earned_at`, `available_at`;
- payout state: `available` → `reserved` → `paid` (or `reversed`).

Earnings are **never** derived from arbitrary frontend totals, and they are
**not** automatically derived from completed bookings yet: the
driver/operator/LeRoutier split (commission formula) is a product decision
that has not been configured. Until then, earning credits are created only
through the explicit domain interface (`earnings.credit` in
`packages/database/src/payouts.js`) — used by automated test fixtures and
available to a future Ops-controlled adjustment action. Documented so the
architecture is complete without inventing economics.

## Withdrawal flow

1. Driver adds a payout destination (country + Mobile Money number + optional
   network; minimal sensitive data, provider beneficiary references preferred
   when available).
2. Driver requests a withdrawal (`POST /api/v1/driver/payouts`):
   authenticated active driver, own destination, amount ≤ available balance,
   optional min/max rules (`PAYOUT_MIN_MINOR` / `PAYOUT_MAX_MINOR`),
   idempotency-key protected.
3. The request reserves the oldest available ledger rows transactionally —
   two requests can never withdraw the same balance.
4. Ops approves (default `PAYOUT_APPROVAL_REQUIRED=true`): the server creates
   and starts the FedaPay payout (`POST /payouts`, `PUT /payouts/start`) with
   LeRoutier correlation metadata.
5. Only a trusted provider result (verified webhook event or an
   Ops-triggered provider status fetch) may mark the request `paid` and the
   ledger rows paid. On provider failure the reservation is released and the
   request returns to a retryable state. The frontend can never mark a payout
   successful.

## FedaPay Payouts activation

FedaPay Payouts is an account feature enabled by FedaPay on request. Until the
merchant account has Payouts activated, `payout.execute` and the Ops approval
flow fail closed with a clear "contact FedaPay" error — verify activation with
FedaPay before wiring live withdrawals.
