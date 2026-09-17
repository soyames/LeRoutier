# Master product-completion workstream

Canonical architecture: apps/web, services/api, packages/domain and the existing
Neon production database. No second frontend, identity system, booking/payment
truth, parcel engine, database or Vercel project was introduced.

This ledger replaces stale implementation claims. READY means the internal
implementation has evidence; it does not imply every external activation has
occurred. See [production readiness](PRODUCTION_READINESS.md) for execution
results and [operational drills](OPERATIONAL_DRILLS.md) for reproducible checks.

| Area | Status | Evidence / remaining gate |
| --- | --- | --- |
| Auth | EXTERNAL | Token/RBAC/provisioning and browser tests; CSP helper origins fixed. Owner completes real Google sign-in. |
| Bookings | READY | Domain/API/DB/live browser suites; no offline confirmation. |
| Capacity | READY | PostgreSQL constraints, final-seat race and occupation checks. |
| Payments | EXTERNAL | FedaPay signatures, amount/currency/reference, duplicate events and reconciliation tested without money. First real transaction requires owner. |
| Payouts | EXTERNAL | Approval, employee/convoyeur denial, reserves and operator beneficiary invariants tested. Provider activation and real payout withheld. |
| Parcels | READY | Full custody lifecycle, private pickup code, public projection, replay and uncollected workflows covered. |
| GPS | PARTIAL | Assigned service, timestamp/accuracy/jump/rate checks; 30-day configurable retention with incident/audit holds tested. Production purge not run under the no-deletion constraint. |
| Routing | READY | Real local OSM/OSRM geometry, duration/legs and cache verified; batch preparation uses existing route records. Production catalogue currently empty. |
| ETA / journey UX | READY | Road progress, stop sequence, movement/duration/schedule and disrupted/unavailable states; no fixed-speed invention. |
| Maps | EXTERNAL | Configurable tiles; no production community-tile default. Text/road/stops remain usable. Production tile entitlement/provider awaits selection. |
| Notifications | EXTERNAL | In-app, event dedup, direct-agent dispatch, retry/dead-letter, attempt audit and preferences implemented. Push/SMS/WhatsApp/email have no contracted/configured sender. |
| USSD | EXTERNAL | Internal engine READY; MTN adapter CONTRACT_PENDING; shortcode, routing and handset test external. |
| Agents | READY | Gemini OAuth primary, shared cooldown/budgets, typed low-risk fallback, PII allowlist, event fingerprints and tenant-bound approvals. |
| Security | PARTIAL | CORS/CSP/headers, safe logs, scans, CodeQL and branch protections; independent penetration test remains external. |
| Privacy / data rights | PARTIAL | Published contact, access/correction/deletion runbook, retention exceptions. Qualified legal retention review remains external. |
| Legal | EXTERNAL | Existing PR integrated; five public pages, entity and provider disclosures. Qualified Benin review outstanding. |
| Observability | READY | Request IDs, safe structured logs, Platform Ops health/signals, scoped diagnostics, failure/cooldown/dead-letter counts. External paging/log retention unavailable. |
| Performance | READY | Nine disposable API/domain workloads; p50/p95/p99/errors/pool/lock observations. No production scale claim. |
| Database | READY | Loopback-only disposable work, fresh/replay checks, integrity constraints, query plans; production Neon pooler verified. |
| Backup/restore | PARTIAL | Actual local pg_dump/pg_restore drill and all-table digest comparison. Production RPO depends on verified provider recovery window. |
| CI / release | READY | Lint/type/build/unit/API/browser/accessibility/migrations/DB/live/drill/audit/secrets/docs gates; no AI/provider spend. |
| PWA | READY | Installable manifest/icons, offline shell only, update prompt, reconnect and explicit pending mutations. |
| Accessibility | READY | Automated axe and keyboard/focus tests across public, legal, passenger, crew and Ops views; mobile viewport. Not a certification. |
| Operations / onboarding | READY | Independent/company verification, staff/vehicle assignments, RBAC and tenant isolation; Gozem suggested_external only. |
| Fare Intelligence | READY | Deterministic engine, segment-level history, external observations, freshness weighting, robust quartiles, advisory-only UI and passenger isolation tested. |
| Commercial model | READY | 5 % commission included in the final price (integer math, gross = commission + net), company plan representation without billing activation, independent drivers: 0 subscription, ledger integration for cash and online transactions. |
| Legacy retirement | EXTERNAL | Shared screens/builds and regression coverage retained. No legacy deployment deleted; explicit owner retirement approval required. |

## Fixed during this continuation

- Production CSP blocked Firebase's helper script and auth iframe.
- Raw API errors could log private paths/messages; request IDs now correlate safe errors.
- GPS ingestion admitted weak accuracy, large jumps and rapid writes.
- ETA used a fixed 50 km/h default; now it requires evidence and respects disruption.
- Notification uniqueness suppressed later events on the same entity.
- Failed notification dispatch could silently mark the outbox event delivered.
- Direct agent notifications were queued without entering the delivery/inbox pipeline.
- Notification supersedes_id referred to itself instead of prior advice.
- Workflow lists/approvals/retries exposed another operator's runs.
- Completed workflow events lacked a persistent input fingerprint.
- Generic auth persistence failure could leave the Firebase SDK's default storage.
- Routine disposable schemas could still use a remote Neon connection.

## Hard constraints

No billing, Blaze, paid Identity Platform, Vertex AI or Gemini API key.
No real FedaPay payment/payout, production deletion, ARCEP submission/payment,
unnecessary credential rotation or legacy deployment deletion.
No legal-compliance or penetration-test completion claim.

USSD_CODE=READY
USSD_INTERNAL_ENGINE=READY
USSD_MTN_ADAPTER=CONTRACT_PENDING
USSD_ARCEP_CODE=EXTERNAL
USSD_OPERATOR_ROUTING=EXTERNAL
USSD_REAL_HANDSET_TEST=EXTERNAL
