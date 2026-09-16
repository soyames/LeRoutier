# Production readiness

The single checklist that must be satisfied before LeRoutier carries real
passengers, real parcels and real money at scale.

**`DONE` means verified, not written.** Code existing is not evidence; a
passing gate, a probe, or a document someone can act from is. Anything else is
`NOT_DONE` or `BLOCKED_EXTERNAL`, including work that is 90 % finished.

Run `pnpm release:check` for the mechanical half of this page.

| Legend | |
| --- | --- |
| `DONE` | verified, with evidence named |
| `PARTIAL` | works, with a stated limitation |
| `NOT_DONE` | not built, or built but unverified |
| `BLOCKED_EXTERNAL` | needs the owner or a provider; the repository cannot do it |

---

## 1. Platform and deployment

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| One canonical product deployment | `DONE` | `le-routier` serves 200 from `main`; git production deployments | — |
| Same-origin `/api/v1` | `DONE` | `le-routier.vercel.app/api/v1/health` → 200 JSON | — |
| SPA deep links survive refresh | `DONE` | `tests/e2e/unified.spec.js` | — |
| Secrets live only where needed | `DONE` | API project holds server secrets; PWA holds `VITE_API_URL` only ([`VERCEL.md`](VERCEL.md)) | — |
| Legacy apps retired | `NOT_DONE` | parity proven by suite; still deployed and still relied on | retire after pilot |
| Custom domain | `BLOCKED_EXTERNAL` | architecture requires no rewrite ([`VERCEL.md`](VERCEL.md)) | owner registers a domain |

## 2. Data

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| Migrations apply from empty | `DONE` | `pnpm test:migrate:fresh` — 12/12, 73 tables, replay moves no `applied_at` | — |
| Local dev/test isolated from production | `DONE` | `compose.yaml`, PostgreSQL 18 matching Neon 18.6 | — |
| Tests cannot touch production | `DONE` | `guards.js`; `dropDisposableSchema` only drops `lr_test_*`; CI holds no production credential | — |
| TLS to any remote database | `DONE` | verified TLS unless the host is loopback — decided from the URL, not a flag | — |
| **Production separated from development** | `NOT_DONE` | one Neon instance, separated only by schema | create a second Neon project ([`DATABASE_ENVIRONMENTS.md`](DATABASE_ENVIRONMENTS.md)) |
| Backup and restore verified | `NOT_DONE` | Neon PITR documented; **never exercised** | restore to a scratch branch and time it |
| Index review under real access patterns | `NOT_DONE` | indexes exist per migration; not profiled against volume | `EXPLAIN` the search, manifest and tracking paths |
| Retention policy enforced | `NOT_DONE` | `vehicle_positions` never expires ([`PRIVACY_AND_RETENTION.md`](../security/PRIVACY_AND_RETENTION.md)) | set a period, then automate it |

## 3. Identity and access

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| Firebase ID-token verification | `DONE` | signature, issuer, audience, expiry against Google's keys; `services/api/tests/auth.test.js` |
| Production fails closed when unconfigured | `DONE` | `auth.spec.js`; no permissive fallback | — |
| Demo login impossible in production | `DONE` | `services/api/tests/http.test.js` | — |
| Authorization enforced server-side | `DONE` | [`AUTHORIZATION_MATRIX.md`](../security/AUTHORIZATION_MATRIX.md) with a test per row | — |
| Google Sign-In configured | `DONE` | provider enabled; web app registered; `le-routier.vercel.app` authorised |
| Auth variables set | `DONE` | four values on `le-routier-api`; `auth/config` publishes them at runtime |
| No service-account material anywhere | `DONE` | Admin SDK not installed; secret scan rejects service-account shapes and `GOCSPX-` |
| Scopes limited to identity | `DONE` | `openid profile email` only, asserted against the source by test |
| Free tier only, no billing | `DONE` | [`FIREBASE_FREE_TIER.md`](FIREBASE_FREE_TIER.md) — auth only; no Firestore, Storage or Functions |
| **Real production login** | `PENDING` | everything is configured; one real sign-in remains | owner or maintainer signs in once |
| MFA for Platform Ops | `BLOCKED_EXTERNAL` | not enforceable by this application | enforce at the provider |

## 4. Money

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| Amounts server-authoritative | `DONE` | client amounts are never trusted | — |
| Webhook signature verified | `DONE` | HMAC-SHA256, timing-safe, timestamp tolerance (`fedapay.test.js`) | — |
| Return URL cannot confirm payment | `DONE` | only a signed provider event moves state | — |
| Replay and duplicate safe | `DONE` | idempotency keys and receipts (`fedapay.test.js`) | — |
| Company employees cannot withdraw | `DONE` | `provisioning.test.js`, `payouts` tests | — |
| Payout requires approval | `DONE` | `PAYOUT_APPROVAL_REQUIRED` default true; `agentic.test.js` | — |
| Failed payout releases the reserve | `DONE` | `agentic.test.js` | — |
| **Live payment tested end to end** | `BLOCKED_EXTERNAL` | never executed — explicitly out of scope without authorization | owner runs one small real transaction |
| Ledger conservation invariant | `PARTIAL` | reserve/release covered; no standing total-conservation assertion | add a ledger invariant diagnostic |

## 5. Core journeys

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| Segment capacity cannot oversell | `DONE` | `capacity.test.js`, concurrent cases | — |
| Booking → payment → ticket → boarding | `DONE` | `pnpm test:live:local`, real API and database | — |
| Walk-up cash belongs to the operator | `DONE` | `walkup` tests | — |
| Parcel custody and pickup codes | `DONE` | `parcels.test.js` | — |
| Public parcel tracking leaks no party | `DONE` | `parcels.test.js`, `tests/e2e/parcels.spec.js` | — |
| Offline crew queue | `DONE` | `tests/e2e/unified.spec.js` | — |
| Load tested | `NOT_DONE` | never run | exercise search, booking, GPS and tracking against Docker |

## 6. Maps, tracking and ETA

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| Real Benin geography, verified | `DONE` | Overpass: 67 road relations, RNIE 2 = 10 102 vertices / 831 km ([`MAPS_ROUTING_AND_TRACKING.md`](../architecture/MAPS_ROUTING_AND_TRACKING.md)) | — |
| No straight line drawn as a road | `DONE` | `tests/e2e/tracking.spec.js` | — |
| "Live" only with recent GPS | `DONE` | `tracking.spec.js` — stale, delayed and absent all covered | — |
| ETA states its confidence | `DONE` | `tracking.spec.js`, geometry unit tests | — |
| Only assigned crew publish positions | `DONE` | `tracking.test.js` | — |
| OSM attribution carried | `DONE` | `tracking.spec.js` | — |
| Degrades without tiles or routing | `DONE` | tile requests blocked in the whole browser suite | — |
| **Production routing engine** | `BLOCKED_EXTERNAL` | adapter ships; **no default endpoint**, demo servers forbid production use | self-host OSRM with a Benin extract, set `ROUTING_URL` |
| **Production tile service** | `NOT_DONE` | public OSM tiles are not fit for production volume | move `TILE_STYLES` to a hosted or self-run service |
| Server-side GPS write limits | `NOT_DONE` | device-side throttle and accuracy filter only | add a per-service ingestion limit |

## 7. Agentic operations

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| Agents cannot reach the database | `DONE` | no credential; domain services only (`agentic.test.js`) | — |
| Principals isolated from humans | `DONE` | separate namespace; approvals run as the deciding human | — |
| Scopes least-privilege, operator-bound | `DONE` | `agentic.test.js` | — |
| Actions typed, no free-form commands | `DONE` | `packages/agents/src/actions.js` | — |
| High-risk actions approval-gated | `DONE` | `agentic.test.js`, exactly-once decisions | — |
| Retries idempotent | `DONE` | receipts; one open run per (workflow, aggregate, trigger) | — |
| Every mutation audited | `DONE` | `audit_events` | — |
| Autonomy configurable per workflow | `DONE` | observe / recommend / auto_low_risk / approval_required; bad values resolve to the safest | — |
| Prompt injection mitigated | `DONE` | structural — nothing for injected text to call (`agentic.test.js`) | — |
| Agent observability metrics | `NOT_DONE` | run data exists; no aggregated metrics | derive from `workflow_runs` |
| Agentic load tested | `NOT_DONE` | never run | burst duplicate events against Docker |

### Model-assisted reasoning

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| OpenRouter provider implemented | `DONE` | OpenAI-compatible, behind the provider interface | — |
| Production provider configured | `DONE` | `AGENT_MODEL_PROVIDER=openrouter` on `le-routier-api` | — |
| **Live connectivity verified** | `DONE` | two live calls: auth accepted, valid structured output, validated against the catalog, nothing executed | — |
| Local MiniCPM still selectable | `DONE` | `AGENT_MODEL_PROVIDER=local`, no key required | — |
| Model failure is safe | `DONE` | every path degrades to "no recommendation"; a booking completes while the provider throws on every call | — |
| Model cannot execute anything | `DONE` | suggestion validated against the real catalog, scopes and approval gates | — |
| No PII leaves for a model | `DONE` | allowlist projections, asserted by `unsafeFields()` in tests | — |
| Prompt injection mitigated | `DONE` | separate policy/content turns; no free-form command path | — |
| Secrets never exposed | `DONE` | no key, header or payload in any error, log or response — four failure modes tested | — |
| Usage ceilings enforced | `DONE` | daily and per-workflow caps in the database; duplicate suppression | — |
| CI never spends quota | `DONE` | every provider call in the suite uses an injected fetch | — |
| **API key stored as Sensitive** | `NOT_DONE` | `OPENROUTER_API_KEY` is a **Config** variable, unlike `DATABASE_URL` and `FEDAPAY_*`, and is exposed to **Preview** as well as Production | re-add as Sensitive, Production-only — see [`VERCEL.md`](VERCEL.md) |
| Model latency suitable for a request path | `NOT_DONE` | measured 6.5 s–49 s on the free tier | keep model calls in the workflow tick; never in a user request |
| Triage wired into a workflow | `NOT_DONE` | the layer, its endpoints and its safety are complete; no workflow calls `recommend()` yet | enable per workflow under `observe` first |

## 8. Security

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| Threat model | `DONE` | [`THREAT_MODEL.md`](../security/THREAT_MODEL.md) | review on each new integration |
| Authorization matrix | `DONE` | [`AUTHORIZATION_MATRIX.md`](../security/AUTHORIZATION_MATRIX.md) | — |
| Privacy and retention position | `PARTIAL` | [`PRIVACY_AND_RETENTION.md`](../security/PRIVACY_AND_RETENTION.md); retention unset | ⚖ legal review |
| Secret scan over tree, diff, history, bundles | `DONE` | `pnpm secrets:check`; every `apps/*/dist` | — |
| Security headers | `DONE` | CSP, frame-ancestors, Permissions-Policy, Referrer-Policy; HSTS at the edge | narrow `connect-src` once OIDC is chosen |
| Rate limiting | `PARTIAL` | authenticated writes and anonymous reads metered | coarse; no distributed-flood defence |
| `main` protected, CI required | `DONE` | no force-push, no deletion, checks required, admin not locked out | — |
| Secret scanning + push protection | `DONE` | enabled on the repository | — |
| Dependabot alerts and updates | `DONE` | enabled; grouped weekly | — |
| CodeQL | `DONE` | `security-extended`, weekly plus per-PR | — |
| Vulnerability reporting route | `DONE` | [`../../SECURITY.md`](../../SECURITY.md) | — |
| Advanced secret-scanning extras | `BLOCKED_EXTERNAL` | validity checks and non-provider patterns need GHAS | owner's plan decision |
| SBOM | `NOT_DONE` | — | generate on release |
| Penetration test | `NOT_DONE` | never performed | commission before broad launch |

## 9. Quality gates

| Requirement | Status | Evidence |
| --- | --- | --- |
| Lint, typecheck, build | `DONE` | CI `quality` job |
| Unit, API, browser suites | `DONE` | CI `quality` and `browser` jobs |
| Database suite on real PostgreSQL | `DONE` | CI `database` job, PostgreSQL 18 service |
| Migration-from-empty | `DONE` | CI `database` job |
| Live end-to-end journeys | `DONE` | CI `database` job |
| Secret scan in CI | `DONE` | CI `quality` job, pattern mode |
| Vercel-identical builds per app | `DONE` | CI `app-root-build` matrix |
| Single release command | `DONE` | `pnpm release:check` |
| Accessibility audit | `NOT_DONE` | keyboard, focus and labels exercised incidentally | run an axe pass |

## 10. Operability

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| Runbooks | `DONE` | [`RUNBOOKS.md`](RUNBOOKS.md) | — |
| Service objectives | `DONE` | [`SLO_AND_MONITORING.md`](SLO_AND_MONITORING.md) | — |
| Incident severity and escalation | `DONE` | same document | — |
| Ops diagnostics | `DONE` | `GET /api/v1/ops/diagnostics` | — |
| Structured error logging without PII | `DONE` | code and message only; `requestId` on every error | — |
| **Correlation id end to end** | `NOT_DONE` | per-response only | propagate browser → API → workflow |
| **Alert routing** | `NOT_DONE` | diagnostics must be looked at | route SEV1 to a human channel |
| Log retention beyond the platform window | `NOT_DONE` | — | ship logs somewhere queryable |

## 11. Customer-facing obligations

| Requirement | Status | Action |
| --- | --- | --- |
| Privacy policy | `PARTIAL` | published at `/privacy`, and its Google/Firebase section matches the implementation (asserted by test) | ⚖ full legal review |
| Terms of service | `NOT_DONE` | ⚖ legal |
| Cancellation and refund terms | `NOT_DONE` | ⚖ business decision, then implement |
| Prohibited parcel categories notice | `NOT_DONE` | ⚖ business and legal |
| Support contact route | `NOT_DONE` | choose a channel and publish it |
| Data-request contact | `NOT_DONE` | ⚖ publish alongside the privacy policy |

---

## The short answer

**Ready:** the architecture, the domain invariants, the security posture, the
test and release gates, maps and tracking, and the agentic layer.

**Not ready, and known:** production/development database separation, an
untested restore, retention policy, a production routing engine and tile
service, observability routing, load and accessibility testing, and every
customer-facing legal document.

**Waiting on someone else:** the OIDC provider, one real payment, a routing
engine entitlement, a domain, and legal review.

Nothing in the first list should be taken as permission to skip the second.

---

## 12. USSD channel

A feature phone with no data plan is still the most common way to reach a bus in
Benin. See [`../architecture/USSD.md`](../architecture/USSD.md).

| Requirement | Status | Evidence | Action |
| --- | --- | --- | --- |
| Provider-neutral adapter | `DONE` | sandbox + generic HMAC; an unknown name resolves to **no** adapter | — |
| Callback verification | `DONE` | HMAC-SHA256, constant-time, raw body; missing secret or signature never passes | — |
| Endpoint hidden when unconfigured | `DONE` | 404 unless `USSD_PROVIDER` names a real adapter | — |
| No parallel booking logic | `DONE` | the same `domain.search` and `domain.hold` the PWA uses | — |
| Segment capacity honoured | `DONE` | concurrent web + USSD test: exactly one channel takes the last seat | — |
| Fares are server-authoritative | `DONE` | the confirmation screen re-reads availability; nothing is cached | — |
| Payment truth preserved | `DONE` | USSD initiates only; a keypress never marks a fare paid | — |
| Identity: no creation, no promotion | `DONE` | binds an **existing** passenger only, and only on a verified callback | — |
| MSISDN trust is opt-in | `DONE` | `USSD_TRUST_PROVIDER_MSISDN`, default false, assumption documented | — |
| Idempotency and replay | `DONE` | per-request fingerprint; session-derived hold key | — |
| Session expiry and cleanup | `DONE` | TTL, expired calls restart, `sweep()` drops old transcripts | — |
| Phone numbers never stored | `DONE` | hashed for storage, masked for output — asserted by test | — |
| Screen length and pagination | `DONE` | navigation reserved first; lists split rather than truncate | — |
| Rate limiting | `DONE` | per-caller session throttle plus the API limiter, separate buckets | — |
| French UX, no English leakage | `DONE` | one catalogue; asserted by test | — |
| Local development harness | `DONE` | `pnpm ussd:dev` — no telecom contract needed | — |
| No new Vercel project or database | `DONE` | webhook inside `le-routier-api`; two tables in the existing Neon database | — |
| Tests | `DONE` | 22 unit, 9 webhook, 26 journey — including concurrency and replay | — |
| MTN Benin adapter | `PARTIAL` | implemented from MTN's published API description; `contract.confirmed` is false | confirm field mapping against the portal Swagger |
| Moov / Celtiis adapters | `NOT_DONE` | separate commercial relationships; one MTN API is not all-network USSD | a contract per operator, or one aggregator |
| **Operator or aggregator routing** | `BLOCKED_EXTERNAL` | allocation is regulatory, reach is commercial | sign a routing contract |
| **ARCEP SVA declaration** | `BLOCKED_EXTERNAL` | prerequisite for a code; 100 000 FCFA + 100 000/yr, 5 years ([`USSD_ARCEP_APPLICATION.md`](USSD_ARCEP_APPLICATION.md)) | owner submits |
| **ARCEP USSD code** | `BLOCKED_EXTERNAL` | pack prepared; allocation list checked against v1.1 of 04/02/2026 (65 codes) | owner submits; 400 000 FCFA year one |
| **Live handset test** | `PENDING` | nothing in the product claims a shortcode exists | after allocation and routing |
| Multi-seat booking | `NOT_DONE` | one booking is one seat, matching the domain | a product decision, not a USSD one |
| Observability | `NOT_DONE` | sessions and steps are stored; no aggregated metrics | derive from `ussd_sessions` |
| Agentic triage from USSD | `NOT_DONE` | deliberately off the response path | after a provider exists |
