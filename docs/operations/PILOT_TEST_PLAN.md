# Controlled pilot test plan

The plan for taking LeRoutier from "production-ready" to "a small number of real
people used it and we know it worked".

**Nothing here is executed automatically.** The two money sections require
explicit human authorisation each time.

## Preconditions

| | Status |
| --- | --- |
| Production schema `leroutier`, migrations 001–009 | done |
| `pnpm smoke:prod` 14/14 | done |
| Production contains no fake business data | verified — all business tables at 0 |
| OIDC provider configured | **blocker** — see `AUTH_PRODUCTION_SETUP.md` |
| FedaPay collections | configured (`payments/config` reports available) |
| FedaPay payouts activated | **blocker** — confirm with FedaPay |
| Notification providers | **blocker** — in-app only until configured |

Everything below past step 2 is blocked on OIDC: no one can sign in, so no real
entity can be created.

## Checklist

Each pilot entity is created through the **real flow**, exactly as a user
would. Nothing is inserted directly into the database.

### Platform

1. Configure the OIDC provider → `AUTH_PRODUCTION_SETUP.md`.
2. `GET /api/v1/auth/config` returns an `oidc` block and `demoLogin: false`.
3. Bootstrap the first Platform Ops identity → `production-auth.md`
   (`pnpm db:bootstrap`, explicit, idempotent, audited, prints no identifiers).

### Independent owner-driver (archetype A)

4. Sign in with the driver's own identity → passenger account created.
5. `/onboarding` → *Je suis chauffeur indépendant* → operator created
   `pending_verification`; the same identity becomes owner, admin and driver.
6. Platform Ops verifies the operator → state becomes `verified`.
7. Add the vehicle (`/ops/fleet` or during onboarding).
8. Propose a boarding point; Platform Ops moderates it to `verified`.
9. Create the route, fares and the first service.
10. Confirm `/work/today` shows the service, and `/work/earnings` shows a
    revenue balance of 0.

### Transport company (archetype B)

11. Company administrator signs in → passenger account created.
12. `/onboarding` → *Je représente une compagnie* → company operator created
    `pending_verification`, that identity becomes its administrator.
13. Platform Ops verifies the company.
14. Add a station from a verified boarding point.
15. Add a vehicle.
16. Provision a company **Driver** (their own identity, provisioned by the
    admin — never self-service).
17. Provision a **Convoyeur** likewise.
18. Create the route, fares and a service; assign driver, convoyeur and vehicle.
19. Driver signs in → sees only their assigned service, no revenue tools.
20. Convoyeur signs in → crew workspace with manifest, parcels, walk-up.

### Passenger journey

21. Passenger signs in, completes their profile.
22. Search → choose a trip → booking held.
23. Pay through FedaPay (see *Controlled real payment* below).
24. Booking confirmed by the verified webhook; ticket QR issued.
25. First-mile card shows the exact boarding point, leave-time advice and the
    Gozem external handoff.
26. Crew scans the QR at the boarding point → passenger aboard.
27. Notification centre shows booking, payment and ticket events.

### Operations

28. Walk-up cash sale by crew → passenger aboard, revenue credited to the
    operator, receipt reference recorded.
29. Parcel: create → accept → assign to service → load → in transit → arrive →
    ready for pickup → collect with the pickup code.
30. Public parcel tracking shows the timeline and no party data.
31. Report an incident from the crew screen; Ops resolves it.
32. Reschedule a service; confirm passengers are notified once and the
    leave-time advice is recomputed, not duplicated.
33. Review settlements; confirm the balance matches the cash and online
    collections recorded.

## Controlled real payment — one transaction

**Requires explicit authorisation before execution.**

Purpose: prove the full money path end to end with the smallest possible
exposure — one real passenger, one real low-value fare.

Prerequisites:

- OIDC configured; a real passenger identity exists with a completed profile.
- A real, verified operator with a published service and a low fare.
- `GET /api/v1/payments/config` reports `available: true`.
- FedaPay webhook endpoint enabled and pointing at
  `https://le-routier-api.vercel.app/api/v1/webhooks/fedapay`, with the
  per-endpoint secret set in `FEDAPAY_WEBHOOK_SECRET`.

Record **before**: booking count, payment count, the operator's settlement
balance, and the `payments` row states.

Steps:

1. Passenger books the low-fare segment → booking `held` with an expiry.
2. Passenger taps *Payer en ligne* → redirected to FedaPay.
3. Pay with a real instrument for the real fare.
4. Return to the app; it polls trusted server state — the app must **not**
   confirm on the return URL alone.
5. FedaPay delivers the webhook; the signature is verified; the payment becomes
   `succeeded`.
6. Passenger confirms → booking `confirmed`; ticket QR issued.

Expected **after**: exactly one new `payments` row `succeeded` with the
provider reference; one booking `confirmed`; one ticket credential; audit
entries for the payment and the booking transition; passenger notified.

Abort criteria: if the webhook does not arrive within a few minutes, do **not**
confirm manually. Investigate through `/ops/payments` — an unreconciled payment
is a known, handled state, and manual reconciliation is an Ops action with its
own audit entry.

## Controlled real payout — one withdrawal

**Requires explicit authorisation before execution. Do not run until the
payment test above has settled.**

Prerequisites, all of which must be true:

1. FedaPay has **activated Payouts** on the account (currently unconfirmed).
2. `FEDAPAY_PAYOUT_SECRET_KEY` is set and distinct from the collection key.
3. `PAYOUT_APPROVAL_REQUIRED=true`.
4. `GET /api/v1/payments/config` reports `payouts.available: true`.
5. The operator is `verified` and is an independent owner-driver (only the
   owner of an independent operator may withdraw).
6. The operator's settlement balance is at least the withdrawal amount, and the
   balance came from **real** collections.
7. A payout destination (Mobile Money number) is registered and verified as
   belonging to the operator.

Record **before**: available / reserved / paid balances, and the payout request
list.

Steps:

1. Owner-driver requests the **minimum viable amount** from `/work/earnings`.
2. The balance moves from `available` to `reserved`; the request is `requested`.
3. Ops approves it — the approval gate is mandatory and audited.
4. The provider executes; the status becomes `processing`, then `paid` on the
   verified webhook.
5. Confirm the money arrived at the destination number.

Expected **after**: one `operator_payout_requests` row `paid`; the reserved
balance moved to `paid`; audit entries for request, approval and settlement;
the owner notified.

Abort criteria: a `failed` status must release the reservation back to
`available`. Verify that it did before retrying.

## Pilot metrics

Measured from real data only — no value is fabricated, and a metric with no
data reads as zero rather than as an estimate.

| Area | Signals | Source |
| --- | --- | --- |
| Supply | active operators, independent drivers, services per week, seats offered | `operators`, `services`, `service_seats` |
| Passenger | searches, search→booking, booking→payment, completed trips, repeat passengers | `bookings`, `payments`, `mobility_handoff_events` |
| Operations | QR boardings, walk-up sales, cash bookings, failed boardings, delays, incidents | `boarding_events`, `audit_events`, `incidents` |
| Parcels | accepted, delivered, delivery time, exceptions, uncollected | `parcels`, `parcel_events`, `parcel_exceptions` |
| First mile | suggestion shown, handoff clicked, directions clicked | `mobility_handoff_events` |
| Notifications | created, read, delivery status per channel | `notifications`, `notification_deliveries` |

`GET /api/v1/ops/diagnostics` already exposes the exception-side counters
(failed payments, open incidents, stale tracking, failed workflows, uncollected
parcels) to authorised Ops. It returns **counts only** — no party data, no
identifiers, no secrets.

Privacy holds throughout: no passenger home or current location is ever stored
(`mobility_handoff_events` has no coordinate column), parcel party details stay
behind authorisation, and no PII is added for analytics.

## What "pilot ready" means

The platform is ready when steps 1–33 have been completed by real people
against production, and the two money tests have each been run once with
explicit authorisation and the expected before/after states confirmed.
