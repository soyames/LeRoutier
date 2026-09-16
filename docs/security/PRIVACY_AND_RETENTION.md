# Privacy and data retention

What LeRoutier actually stores, why it is needed, how long it is kept, and who
can see it.

> **This document is a technical description, not a legal opinion.** Nothing
> here asserts compliance with any specific regime. Items marked
> **⚖ LEGAL REVIEW** need a qualified review before broad public use — and
> before the privacy policy that faces customers is published.

## Principles the code already follows

- **Collect at the moment of need.** A passenger can search, compare and track
  a parcel without an account. Identity is asked for at the action that
  requires it.
- **The passenger's own position never leaves their device.** First-mile advice
  is computed locally. `mobility_handoff_events` deliberately has **no
  coordinate column** — the schema cannot store it even by accident.
- **Public means public-safe.** Parcel tracking by number returns status,
  cities, point names and a coarse vehicle-derived position. Never a sender, a
  receiver, a phone number, a pickup code or a payment.
- **No behavioural surveillance.** No session replay, no cross-site tracking,
  no advertising identifiers, no third-party analytics script.

## Data inventory

| Data | Why it exists | Retention today | Who can read it |
| --- | --- | --- | --- |
| Firebase subject + issuer | to recognise a returning person | life of the account | the person; Platform Ops |
| Display name | to address people, and for manifests | life of the account | the person; their operator when travelling; Platform Ops |
| Phone number | boarding contact, parcel coordination | life of the account | the person; the operator for a relevant journey or parcel; Platform Ops |
| Session token | to stay signed in | **session-scoped, cleared with the tab** | nobody |
| Booking, segments, seat | the reservation itself | **⚖ LEGAL REVIEW** — indefinite today | the passenger; their operator; Platform Ops |
| Ticket QR token | to board without a paper ticket | until the service completes | the passenger; scanning crew |
| Boarding / alighting events | manifest truth and capacity release | with the booking | the operator; Platform Ops |
| Payment reference and status | to reconcile with the provider | **⚖ LEGAL REVIEW** — likely a statutory minimum | the payer; their operator; Platform Ops |
| Ledger entries, operator balance | to know whose money it is | **⚖ LEGAL REVIEW** — accounting retention | the operator owner; Platform Ops |
| Payout destination | to send money to the right place | while the destination is in use | the owner; Platform Ops |
| **Vehicle GPS positions** | live tracking, progress, ETA | **⚖ LEGAL REVIEW** — indefinite today, **see below** | the passenger for their own journey; the operator; Platform Ops |
| Parcel sender / receiver | custody and handover | with the parcel record | the operator handling it; the two parties |
| Pickup code | to release a parcel to the right person | until collected | the receiver; releasing crew |
| Crew licence details | operator compliance | while the person is crew | their operator; Platform Ops |
| Notifications | the record of what a person was told | **⚖ LEGAL REVIEW** — indefinite today | the recipient; Platform Ops |
| Audit events | who did what | **deliberately never pruned** | operator Ops within scope; Platform Ops |
| Agent action receipts | idempotency and accountability | with the workflow run | Platform Ops |
| Request rate counters | abuse control | short-lived, per minute window | nobody, operationally |

### Vehicle GPS deserves its own paragraph

A vehicle position is not only a vehicle's position. Over a working day it is
also a record of where a named driver was, minute by minute. It is the most
sensitive continuous dataset this platform holds about its own workers.

What is true today:

- Capture is **opt-in per service** and stops when the service stops. Crew turn
  it on; it is not silently always-on.
- Only crew **assigned to that service** can publish. A closed service refuses.
- Exact coordinates are never public. The public parcel view keeps a coarse,
  privacy-preserving projection.
- Passengers see the vehicle on their own journey, not a driver's history.

What is **not** true yet, and should be before scale:

- **There is no automatic expiry of `vehicle_positions`.** The recommended
  policy is to keep full-resolution positions for a short operational window
  (long enough for a dispute about a single journey), then reduce to
  per-service summaries — departure, arrival, distance — and delete the
  individual fixes. Tracked as an open item; the threshold is an operational
  and **⚖ LEGAL REVIEW** decision, not a number to invent here.

## Deletion and anonymisation

| Request | What can happen today | Gap |
| --- | --- | --- |
| "Delete my account" | identity can be disabled, which immediately fails every request closed | no automated erasure flow — **⚖ LEGAL REVIEW** |
| "Delete my bookings" | cannot be honoured in full: a booking is also the operator's commercial and accounting record | the lawful balance between erasure and retention is **⚖ LEGAL REVIEW** |
| "What do you hold about me?" | assembled manually from the account, bookings, parcels and notifications | no self-service export — **open item** |
| Crew leaves an operator | membership deactivated; historical manifests and audit remain, correctly | — |

**The audit log is deliberately exempt from erasure.** It is the record that
makes every other control meaningful. Anonymising it would remove the ability
to answer "who approved this payout" — which is exactly what it exists for. How
that interacts with an erasure request is **⚖ LEGAL REVIEW**.

## Sharing with third parties

| Party | What they receive | What they never receive |
| --- | --- | --- |
| FedaPay | the amount, currency and a LeRoutier reference needed to take a payment | journey details, parcel contents, location |
| Gozem | **nothing.** The handoff is a link the passenger chooses to follow | LeRoutier sends no booking, no identity, no position |
| OpenStreetMap / CARTO | tile requests from the user's browser, as any map does | no LeRoutier identifier is attached |
| Google / Firebase Authentication | authentication and basic profile only — identity, name, email | no travel, parcel or payment data; LeRoutier requests no Gmail, Drive, Calendar or Contacts scope |
| Neon, Vercel | infrastructure processors | — |

Gozem is worth restating because it is easy to assume otherwise: LeRoutier
**suggests** a provider and **books nothing**. No fare, no ETA, no ride, and no
passenger data leaves the device for it.

## Security of the data

Covered in [`SECURITY_MODEL.md`](SECURITY_MODEL.md) and
[`THREAT_MODEL.md`](THREAT_MODEL.md). In summary: TLS everywhere the database
is remote, operator scoping applied in the query, secrets only in the API
project's server-side environment, and a secret scan over the tree, the diff,
the history and every built bundle.

## Before public launch

1. ⚖ Set and implement a retention period for `vehicle_positions`, then
   automate it.
2. ⚖ Decide retention for bookings, payments and notifications against Benin's
   requirements, then automate it.
3. ⚖ Have the customer-facing privacy policy reviewed; it must match this
   document, not aspire beyond it.
4. Build a data-access/export request path so the answer is not "manually".
5. Publish a data-privacy contact route — see [`../../SECURITY.md`](../../SECURITY.md)
   for the reporting pattern to follow.
