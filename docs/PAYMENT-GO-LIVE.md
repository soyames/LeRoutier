# Payments and payouts: the two real transactions

Everything in the payment and payout path is implemented and covered by
provider-independent tests. Two things cannot be proven from a development
environment, because each moves real money:

1. one real collection — a passenger actually paying;
2. one real payout — a driver actually receiving.

Both must be performed by the project owner. This file is the checklist for
doing them once, deliberately, and recording the result.

**Do not treat either as done until the evidence column is filled in.**

## Before starting

| Check | How | Expected |
|---|---|---|
| Environment is `live` | `GET /api/v1/ops/diagnostics` as Platform Ops | `fedapay.environment` is `live` |
| Collections configured | same response | `fedapay.collections` is `true` |
| Payout capability | same response | `fedapay.payouts.state` — see below |
| Webhook registered | FedaPay dashboard | points at `https://api.leroutier.app/api/v1/webhooks/fedapay` |
| Webhook secret matches | `FEDAPAY_WEBHOOK_SECRET` on `le-routier-api` | equals the dashboard's signing secret |
| Webhook endpoint answers | `curl -X POST .../webhooks/fedapay -d '{}'` | `401 INVALID_WEBHOOK` — verified 2026-09-22 |
| No competing variables | `vercel env ls le-routier-api` | one of each FedaPay name — verified 2026-09-22 |

The payout states, in increasing order of what is actually proven:

- `missing_provider` — no payment adapter
- `missing_credentials` — no `FEDAPAY_PAYOUT_SECRET_KEY`
- `provider_not_activated` — the provider refused recent attempts; on FedaPay
  this is what an unactivated Payouts account looks like from here
- `configured` — credentials present, never proven by a real transfer
- `available` — a transfer has completed

Only `available` is a claim. The driver-facing screen says the right thing for
each of the others, and a withdrawal button is not offered where it cannot work.

## 1. The real collection

Use the smallest fare on a real published service. A passenger account you
control, paying with a method you own.

| # | Step | Expected | Result | Evidence |
|---|---|---|---|---|
| 1.1 | Search and hold a seat on a real service | booking `held`, amount from the service | | |
| 1.2 | Start payment | redirect to FedaPay, amount matches the booking exactly | | |
| 1.3 | Inspect the checkout amount | equals 1.1 — a different figure here means the amount is not server-authoritative | | |
| 1.4 | Complete payment with a real method | FedaPay reports success | | |
| 1.5 | Webhook arrives | `payment_events` has one row for the event id | | |
| 1.6 | Booking state | `confirmed`, ticket issuable | | |
| 1.7 | Operator settlement | `operator_settlements` credited gross minus 5% commission | | |
| 1.8 | Receipt | passenger can open ticket, invoice and receipt | | |
| 1.9 | Replay the webhook from the dashboard | booking unchanged, no second settlement credit | | |
| 1.10 | Refund from the FedaPay dashboard | booking `cancelled`, seat released, refund on the receipt | | |

If 1.3 disagrees with 1.1, **stop**. That is the one failure that cannot be
reconciled afterwards.

## 2. The real payout

Only after section 1. Use an independent owner-driver account you control, with
a Mobile Money number you own, for the smallest amount the provider accepts.

| # | Step | Expected | Result | Evidence |
|---|---|---|---|---|
| 2.1 | Read the capability | `configured` (or `available` if a transfer already happened) | | |
| 2.2 | Check the balance | equals the settlement ledger | | |
| 2.3 | Request a withdrawal | `requested`, balance reserved not deducted | | |
| 2.4 | Approve as Platform Ops | `processing`, provider reference recorded | | |
| 2.5 | Money arrives | the real number receives it | | |
| 2.6 | Webhook settles it | `paid`, ledger rows `paid` | | |
| 2.7 | Capability afterwards | `available` | | |
| 2.8 | Approve the same request again | refused, `PAYOUT_TRANSITION` — never a second transfer | | |
| 2.9 | Provider rejection path | if the transfer is refused: request returns to a retryable state, reserved balance released back to withdrawable, capability reads `provider_not_activated` rather than `available` | | |
| 2.10 | Balance reconciles | withdrawable balance equals the settlement ledger again, with no amount stranded in reserve | | |

If 2.4 fails with `PAYOUT_UNAVAILABLE`, FedaPay has not activated Payouts for
this account. The balance is released automatically and the capability moves to
`provider_not_activated`; ask FedaPay to activate transfers before retrying.

## Verified on 2026-09-22, without moving money

Three things that can be checked against live production and were:

**The webhook endpoint exists and is signature-guarded.** An unsigned POST to
`https://api.leroutier.app/api/v1/webhooks/fedapay` returns
`401 INVALID_WEBHOOK` — "Webhook signature is missing." — so the route is
deployed and refuses before any processing. What this does NOT prove is that
FedaPay's dashboard points at this URL; only the dashboard can answer that, and
it is the first row of the pre-flight table for that reason.

**The secrets exist once, under the expected names.** Production carries
exactly one each of `FEDAPAY_SECRET_KEY`, `FEDAPAY_PUBLIC_KEY`,
`FEDAPAY_WEBHOOK_SECRET` and `FEDAPAY_PAYOUT_SECRET_KEY`, plus one each of
`FEDAPAY_ENVIRONMENT`, `PAYMENT_PROVIDER` and `PAYOUT_APPROVAL_REQUIRED`. No
duplicates, no alternates, nothing hidden. Preview carries the two
configuration values and **none of the keys**, so a preview deployment cannot
move money.

**The capability is honest.** `GET /api/v1/payments/config` on production
returns:

```json
{"available":true,"payouts":{"available":false,"state":"configured","canRequest":true,"provider":"fedapay"}}
```

`available:true` for collections means an adapter and a secret key are present.
It does **not** mean a passenger has ever paid. `payouts.state:"configured"`
says precisely that credentials exist and no transfer has ever completed — and
`payouts.available:false` alongside it is the whole point of the distinction.
Only section 2 below can move either to proven.

### One thing worth fixing while you are in there

`FEDAPAY_ENVIRONMENT`, `PAYMENT_PROVIDER` and `PAYOUT_APPROVAL_REQUIRED` are
stored as **Sensitive**, which makes them write-only. They are configuration,
not credentials, and nobody — including you — can read back whether
`FEDAPAY_ENVIRONMENT` currently says `live` or `sandbox` without deploying and
observing. A wrong value here is silent. Re-add them with `--no-sensitive` when
convenient; the three keys stay Sensitive, as they should.

## What must never be done to test this

- No real charge against somebody else's payment method.
- No payout to a number you do not control.
- No TEST/demo booking pointed at the live provider — the server refuses this,
  and the refusal is tested, but do not go looking for a way round it.
- No editing of a real operator's records to make a test easier.

## Already proven, without moving money

The following hold against the running domain and do not need a real
transaction to be trusted:

- the charged amount comes from the booking; every attempt to supply one is
  refused, and a provider event with a different amount never confirms;
- a replayed webhook is idempotent, and a reused event id carrying different
  data is refused rather than applied;
- unsigned, forged and stale signatures never reach the domain;
- a TEST service cannot reach the real provider at all;
- revenue belongs to the operator: a company driver, a company administrator
  and a convoyeur are each refused the balance, and an owner-driver cannot
  approve their own withdrawal;
- approving twice cannot pay twice;
- a failed transfer releases the reserved balance and stays retryable.
