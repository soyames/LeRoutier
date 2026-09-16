# Threat model

`SECURITY_MODEL.md` states the controls LeRoutier commits to. This document
asks the harder question: **who would attack this system, what would they be
after, and what actually stops them.**

Method is STRIDE, applied per surface. Every threat carries a residual risk,
because a control that has not been tested is a belief, not a control.

| Field | Meaning |
| --- | --- |
| Severity | impact if it succeeded once |
| Likelihood | given the controls in place today |
| Residual | what remains after those controls |

Scope: the unified PWA, the three legacy apps still deployed, `/api/v1`, the
domain services, the database, the agent/workflow layer, and the deployment
pipeline. Out of scope: the OIDC provider's own security, FedaPay's internal
systems, and Neon's infrastructure — each is a trusted third party whose
compromise is modelled as an event, not prevented here.

## Actors

| Actor | Motivation | Starting position |
| --- | --- | --- |
| Anonymous attacker | free travel, data, disruption | public endpoints only |
| Malicious passenger | free or cheaper travel, someone else's ticket or parcel | a real authenticated account |
| Malicious driver | inflate revenue, withdraw money that is not theirs | crew credentials, a real device |
| Malicious convoyeur | cash retention, parcel theft | crew credentials, custody of parcels |
| Malicious operator admin | reach another operator's data or money | full Ops rights within one operator |
| Compromised operator account | anything that account can do | stolen session or device |
| Compromised Platform Ops | total | the widest human privilege in the system |
| Webhook attacker | fabricate a payment success | can reach the public webhook URL |
| Provider compromise | mass forgery | valid provider signatures |
| Insider | data exfiltration, silent change | repository or deployment access |
| Automated bot | scraping, enumeration, resource exhaustion | scale, no credentials |
| Compromised agent principal | privileged automated action | a stolen `lragt_…` token |

## Assets

**Identity** (OIDC subject bindings, sessions, agent tokens) ·
**Passenger PII** (name, phone) · **Crew PII** (licence, phone) ·
**Location** (vehicle GPS history, passenger first-mile position) ·
**Parcel parties** (sender, receiver, pickup codes) ·
**Money** (payments, ledger, operator balances, payout destinations) ·
**Tickets** (QR tokens, boarding state) · **Operator data** (fares, manifests,
revenue) · **Audit log** (the record of who did what).

The audit log is an asset in its own right: an attacker who can edit it can
make every other compromise invisible.

---

## S — Spoofing identity

| # | Threat | Sev | Like | Controls | Residual |
| --- | --- | --- | --- | --- | --- |
| S1 | Forged API token | Critical | Low | JWTs validated against the provider's JWKS with issuer and audience pinned; production **fails closed** when unconfigured — it never falls back to a permissive mode | Depends on the provider's key hygiene |
| S2 | Demo login reachable in production | Critical | Low | `ALLOW_DEMO_LOGIN` defaults false; production config refuses it; browser tests assert the control is absent | Configuration error remains possible — covered by the smoke test |
| S3 | Replayed authorization code | High | Low | Authorization Code + **PKCE**; `state` verified; a callback whose state does not match is rejected (`tests/e2e/auth.spec.js`) | — |
| S4 | Token theft from browser storage | High | Low | Tokens are held **in memory only** — never `localStorage`, never a cookie; a sign-out clears privileged data (tested) | XSS during a live session still reaches the in-memory token; CSP is the mitigation |
| S5 | Stolen agent token | High | Low | Tokens stored only as SHA-256 digests; scoped; operator-bound; deactivatable; every use audited | No automatic rotation yet — **open** |
| S6 | Agent impersonating a human | High | Very low | Agent principals are a distinct identity type and can never be an Ops user; approvals execute under the deciding human's identity | — |
| S7 | Subject rebound to another issuer | Critical | Very low | A known subject cannot be re-bound to a different issuer (`provisioning.test.js`) | — |

## T — Tampering

| # | Threat | Sev | Like | Controls | Residual |
| --- | --- | --- | --- | --- | --- |
| T1 | Client sends its own fare or amount | Critical | Medium | Amounts are **server-authoritative**, derived from the route's fare table; the client's number is never trusted | — |
| T2 | Forged payment webhook | Critical | Medium | HMAC-SHA256 over `timestamp.rawBody`, compared with `timingSafeEqual`, with a timestamp tolerance that rejects stale replays; signature failure is a 401 | Provider key compromise (modelled as provider compromise) |
| T3 | Return URL used to confirm payment | Critical | High | The return URL confirms nothing. Only a signature-valid provider event moves a payment to succeeded | — |
| T4 | Capacity oversold by concurrent booking | High | Medium | Segment allocation is transactional with row-level contention and a database-level invariant; concurrency covered in `capacity.test.js` | — |
| T5 | Passenger forges a GPS position | Medium | Medium | Only crew **assigned to that service** may publish; passengers are refused; a closed service rejects positions; cross-operator submission refused (`tracking.test.js`) | A genuine crew device can still report a false position — see V3 |
| T6 | Migration edited after being applied | High | Low | Checksums are verified on every run; a changed applied migration aborts the whole chain | — |
| T7 | Audit log altered | Critical | Low | `audit_events` is append-only by application contract and never pruned | Database-level write access would bypass it — **open**, mitigated by credential custody |
| T8 | Free text interpreted as an instruction by an agent | High | Medium | Agents execute only a typed catalog with validated schemas; no free-form command path exists | Prompt-injection hardening is documented under §23 and not yet test-backed — **open** |

## R — Repudiation

| # | Threat | Sev | Like | Controls | Residual |
| --- | --- | --- | --- | --- | --- |
| R1 | Operator denies a fare or manifest change | Medium | Medium | Every privileged mutation writes an audit event with actor, operator and details | — |
| R2 | Ops denies approving a payout | High | Low | Approvals are recorded with the deciding identity and are **exactly once** — a second decision is rejected | — |
| R3 | Crew denies taking a cash fare | Medium | Medium | Walk-up sales are attributed to the selling crew member and settle to the operator | Cash never entering the system at all is an operational control, not a technical one — **open by design** |

## I — Information disclosure

| # | Threat | Sev | Like | Controls | Residual |
| --- | --- | --- | --- | --- | --- |
| I1 | Cross-operator data access | Critical | Medium | Operator scoping is applied **in the query**, not the UI; cross-operator manifests, fleet, provisioning and tracking are all refused and tested | — |
| I2 | Passenger reads another passenger's booking | High | Medium | Bookings are filtered by `passenger_id` at the source | — |
| I3 | Public parcel tracking leaks parties | High | Medium | The public endpoint returns status, cities, point names and a coarse vehicle-derived position only — never sender, receiver or pickup code | Tracking-number enumeration — see I6 |
| I4 | Live vehicle coordinates exposed publicly | Medium | Medium | Exact positions require an authenticated, authorized caller; the public parcel view keeps its coarse projection | — |
| I5 | Secret reaches a browser bundle | Critical | Low | Only `VITE_`-prefixed variables can reach a bundle; the secret scan checks **every** `apps/*/dist`, the diff and the full history; Vercel push protection is on | — |
| I6 | Tracking-number or ID enumeration | Medium | Medium | Identifiers are UUIDs or random tracking numbers; rate limiting applies | Per-endpoint enumeration limits are coarse — **open** |
| I7 | Error message leaks internals | Medium | Low | Unknown errors return a generic message and a request id; driver errors are never surfaced; connection details never logged | — |
| I8 | Passenger home location stored | High | Low | First-mile advice is computed **on the device**; the passenger's own position never leaves it, and `mobility_handoff_events` deliberately has no coordinate column | — |
| I9 | Agent receives more data than its task needs | Medium | Medium | Actions declare typed output schemas | Safe projections are not yet enforced everywhere — **open** (§24) |

## D — Denial of service

| # | Threat | Sev | Like | Controls | Residual |
| --- | --- | --- | --- | --- | --- |
| D1 | Request flood | Medium | High | 120 requests per minute per subject, enforced in the database so it holds across serverless instances | A distributed flood needs edge mitigation — **open**, platform-level |
| D2 | Oversized payload | Medium | Medium | Bodies capped at 16 KB; JSON content type required | — |
| D3 | GPS write flood | Medium | Medium | Publication is throttled by distance **or** interval on the device; fixes worse than ~200 m accuracy are discarded; only assigned crew may write | Server-side per-service position rate limiting — **open** (§V) |
| D4 | Free tile/routing infrastructure withdrawn | Medium | Medium | Maps degrade honestly: no tiles still renders stops and text; no routing engine means no road line and every surface says so | Public OSM tiles are explicitly **not** fit for production volume — **open by design**, one-file change |
| D5 | Agent retry storm | Medium | Low | Retries bounded to 3; one open run per (workflow, aggregate, trigger) | Invocation and cost ceilings — **open** (§27) |

## E — Elevation of privilege

| # | Threat | Sev | Like | Controls | Residual |
| --- | --- | --- | --- | --- | --- |
| E1 | Company driver withdraws company money | Critical | Medium | Withdrawal belongs to the operator owner; company employees have no payout path; enforced server-side and tested | — |
| E2 | Operator admin grants itself platform rights | Critical | Low | Operator Ops cannot create operators or grant platform privileges (`provisioning.test.js`) | — |
| E3 | Passenger reaches the Ops workspace | High | Medium | Server refuses the data regardless of navigation; the UI states it plainly rather than hiding it | — |
| E4 | Agent exceeds its scope | High | Low | Every action declares a required scope, checked server-side against the principal | — |
| E5 | Agent writes to the database directly | Critical | Very low | Agents hold no database credential and act only through domain services | — |
| E6 | High-risk action executed without a human | Critical | Low | `privileged` and `financial` actions create a pending approval and cannot self-approve | Per-workflow autonomy levels — **open** (§34) |
| E7 | Disabled identity keeps working | High | Low | Disabled identities and inactive driver profiles fail closed (tested) | — |
| E8 | Test tooling reaches production | Critical | Low | `assertDisposableSchema` requires a disposable schema **and** a non-production runtime; `dropDisposableSchema` can only ever drop `lr_test_*`; CI has no production credential | — |

---

## Agentic surface

The agent layer is inside the trust boundary of the API, not outside it. That
is the whole design: an agent is a constrained client, never a second way in.

- **No database access.** Agents call domain services. The same authorization,
  operator scoping, validation, idempotency and audit apply to an agent action
  and a human one.
- **Typed catalog only.** There is no free-form command endpoint, so a
  hallucinated or injected "instruction" has nothing to call.
- **Untrusted text stays data.** Passenger notes, parcel notes, operator names,
  incident notes and station descriptions are content. They are never policy.
- **Deterministic before generative.** Capacity, fares, payment state, payout
  eligibility, permissions, geometry and state machines are code. No invariant
  lives in a prompt. Today no model is on any critical path at all.
- **Approval gates.** Money and privileged operational change require a human,
  recorded, exactly once.

Open items are tracked in
[`../operations/MASTER_PRODUCT_COMPLETION.md`](../operations/MASTER_PRODUCT_COMPLETION.md)
§22–§28 and §33–§34.

## Trust boundaries

1. **Browser → API.** Everything from the browser is untrusted, including the
   fields of an authenticated user's own request.
2. **API → database.** The API holds the only database credential.
3. **Provider → API.** FedaPay is trusted **only** through a valid signature.
4. **Agent → API.** A scoped, operator-bound, auditable client.
5. **Repository → deployment.** CI holds no production credential; the
   production database URL is a write-only Vercel variable on the API project.

## What would hurt most

Ranked by consequence rather than likelihood, these are the failures worth
spending the next increment of effort on:

1. **A compromised Platform Ops identity.** It is the widest privilege and has
   no second factor enforced by this system. Provider-side MFA is the control,
   and it is outside the application — carried as an external dependency.
2. **Database credential compromise.** It bypasses every application control,
   including the audit log. Custody and rotation are the only mitigations.
3. **Provider key compromise.** Valid signatures would forge payment success at
   scale. Detection would come from reconciliation, not prevention.

## Review

This model is reviewed when a new external integration is added, a new actor or
role appears, the agent layer gains an autonomy level, or a real incident shows
it was wrong.
