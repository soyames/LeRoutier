# Fare Intelligence & commercial model

LeRoutier's pricing model and its operator-facing Fare Intelligence. This is an
operator feature: passengers and parcel senders see only the final amount they
must pay.

## Commercial model (authoritative)

| Party | Subscription | Commission |
| --- | --- | --- |
| Transport companies | fixed monthly SaaS subscription for operational management | 5 % on every passenger-ticket, parcel and express-parcel transaction processed through LeRoutier |
| Independent owner-drivers | 0 (no subscription) | 5 % on every passenger-ticket, parcel and express-parcel transaction |

A company still pays its SaaS subscription even if it sells zero tickets through
LeRoutier. The plan is represented in `operator_plans` with **no billing
activation**: `monthly_price_minor` stays NULL and `billing_status`
`not_billed` until the owner decides business pricing. The schema refuses a
plan row for an independent operator.

## The commission is included in the final customer price

The fare an operator publishes IS the final customer price. LeRoutier never
adds 5 % on top.

| Operator publishes | Passenger pays | LeRoutier commission | Operator net |
| --- | --- | --- | --- |
| 7 500 FCFA | 7 500 FCFA | 375 FCFA | 7 125 FCFA |

Formula (integer money only, no floating point):

    commission = round(final_customer_price × 0.05)
    operator_net = final_customer_price − commission

`gross = commission + net` holds exactly, by construction, for every integer
amount (`packages/domain/src/commission.js`, `splitCommission`).

The same rule applies to passenger fares, parcel standard and parcel express.

## Operator price-entry UX

Before an operator saves a fare, the UI shows the split:

- Prix final client: 7 500 FCFA
- Commission LeRoutier (5 %): 375 FCFA
- Votre montant net: 7 125 FCFA

Passengers and parcel senders never see this breakdown — their view stays
"Total: 7 500 FCFA".

## Fare history — LeRoutier's own market dataset

Every relevant fare publication/change creates historical evidence. History is
append-only: the previous fare is never overwritten, it is closed
(`effective_to`) and the new fare opens the current period
(`fare_observations`).

Recorded for: passenger fare, parcel standard, parcel express. Fields:
origin/destination stop, route/segment where relevant, operator, operator
type, fare type, final customer price (integer FCFA), currency, effective
from/to, observed/recorded at, source type and source reference.

Sources are never mixed: `leroutier_published` (operator publications),
`leroutier_transaction` (completed paid platform transactions, keyed by
payment so duplicate events cannot duplicate evidence) and `external_public`
(manually recorded public-market observations with a safe https source; these
carry no operator id and never enter any operator's own history).

## Segment-level pricing

Fare Intelligence follows the segment model. For a route
Cotonou → Bohicon → Dassa → Savè → Parakou, comparisons exist per valid OD
pair (Cotonou → Bohicon, Cotonou → Parakou, Bohicon → Dassa, …), never only
whole-route averages.

## Deterministic recommendation engine

Gemini never computes a recommended price. `packages/database/src/fare-intelligence.js`
computes, over a freshness-weighted observation window:

- minimum / maximum
- median and lower/upper quartiles (nearest-rank, so one extreme fare cannot
  drag the "typical range" toward itself)
- recency-weighted median (observations older than the window lose all
  importance; observations inside it decay linearly)
- observation counts: total, fresh, own, completed-transaction
- own historical range and completed-transaction range where available

With fewer than 3 fresh observations the engine refuses to fabricate:
« Pas encore assez de données pour une recommandation fiable. »

## Advisory only

The operator remains responsible for the final fare. Fare Intelligence is
comparison + recommendation — never centralized price control. Nothing blocks
a price merely because it differs from competitors, nothing synchronizes
operators' fares, and "Use suggested price" is always an operator action
(for passenger fares it points to creating a new route, because booked
service fares are immutable by design).

## Operator experience

The Ops UI shows, per OD pair and fare type:

- Votre prix actuel
- Fourchette typique du marché
- Prix suggéré
- one plain-French sentence (above / below / within range)
- actions: Utiliser le prix suggéré / Garder mon prix

No percentiles, row counts, source pipelines or scraping metadata.

## Parcel standard / express

Operators define both levels. Express means same-day delivery as actually
operated: eligibility is checked against the qualifying service's acceptance
time, departure and expected arrival (scheduled arrival, or departure plus
route road-duration). Without that evidence Express fails closed — a
same-day promise is never made when the schedule cannot keep it. Express
commission is 5 % of the final express price, identical to standard.

## Ledger integration

For every eligible completed transaction the settlement ledger preserves:
gross (final customer amount), LeRoutier commission (the deduction), operator
net (generated: gross − deduction), currency, transaction type
(`walk_up`, `parcel_cash`, `ticket_online`, `parcel_online`) and operator
beneficiary. Credits are idempotent per (operator, source, reference), so a
replayed provider event can never credit twice.

Cash rules are unchanged: the Passenger PWA is online-payment only; crew
walk-up may take cash. A cash transaction is never recorded as an online
payment — it stays `walk_up` / `parcel_cash`.

## Privacy / commercial confidentiality

One operator's private sales, conversion rate, exact volumes or financial
ledger are never shown to another operator. Comparisons are aggregated and
anonymized; external observations may be referenced internally by source but
the user-facing recommendation stays simplified.
