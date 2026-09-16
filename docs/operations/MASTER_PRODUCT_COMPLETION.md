# Master product-completion ledger

The single execution record for taking LeRoutier from advanced development to a
platform operable at scale. One row per workstream, updated as work lands.

**Status vocabulary** — `DONE` (implemented *and* evidenced), `IN PROGRESS`,
`PLANNED`, `BLOCKED_EXTERNAL` (needs an owner/provider action this repository
cannot perform). Code existing is not evidence; a passing gate is.

Companion documents: [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) is the
release checklist, [`../security/THREAT_MODEL.md`](../security/THREAT_MODEL.md)
the threat analysis, and
[`../architecture/AGENTIC_WORKFLOWS.md`](../architecture/AGENTIC_WORKFLOWS.md)
the agent architecture.

## Activation status

Deliberately not collapsed into one word. Working code and a live service are
different claims, and only the first is true today.

| Key | Status |
| --- | --- |
| `FIREBASE_AUTH_CODE` | **READY** — Firebase ID-token verification, DB-authoritative roles, 30 auth tests |
| `FIREBASE_ADMIN_BACKEND` | **NOT USED — by design** — verification needs no service account, so no private key is stored anywhere |
| `GOOGLE_SIGN_IN` | **READY** — provider enabled; scopes limited to openid/profile/email, asserted by test |
| `PRODUCTION_CONFIG` | **READY** — four variables set on `le-routier-api`; web app registered; `le-routier.vercel.app` authorised |
| `REAL_LOGIN` | **PENDING** — requires one real Google sign-in in production |
| `FREE_TIER_ONLY` | **ENFORCED** — authentication only, Spark plan, no billing account, no Admin SDK |
| `LEGAL_URLS` | **READY** — `/privacy`, `/terms`, `/legal`, `/cancellations`, `/cookies` resolve without an account |
| `USSD_CODE` | **READY** |
| `USSD_INTERNAL_ENGINE` | **READY** — journeys, sessions, idempotency, security, 57 tests |
| `USSD_PROVIDER_ADAPTER` | **READY (unconfirmed)** — sandbox, generic HMAC and MTN implemented; MTN's field mapping awaits the portal Swagger |
| `USSD_ARCEP_CODE` | **PENDING** — application pack prepared; nothing submitted, no fee paid |
| `USSD_OPERATOR_ROUTING` | **PENDING** — no operator or aggregator contract |
| `USSD_REAL_HANDSET_TEST` | **PENDING** — impossible before a code and routing exist |

## Product completion

| § | Workstream | Status | Evidence |
| --- | --- | --- | --- |
| A | Preserve canonical architecture | DONE | One PWA (`apps/web`), one API (`services/api`), one domain. No parallel models introduced. |
| B | Maps & tracking completion | DONE | 26 tracking browser tests (`tests/e2e/tracking.spec.js`); 21 geometry/ETA unit tests; tile servers blocked in tests. |
| C | Canonical Vercel project | DONE | `le-routier` = PWA, `le-routier-api` = server. Secrets stayed on the API. |
| D | Environment-variable consolidation | DONE | [`VERCEL.md`](VERCEL.md) ownership matrix, names only. |
| E | `le-routier` as canonical production | DONE | Git production deployments from `main`; `le-routier.vercel.app` 200; `/api/v1/health` 200 same-origin. |
| F | Legacy app retirement plan | IN PROGRESS | Parity proven by suite; retirement staged, source retained for regression. |
| G | Docker local database | DONE | `compose.yaml` (PostgreSQL 18, matching Neon 18.6), `pnpm docker:up`, healthcheck verified. |
| H | Database environment model | DONE | [`DATABASE_ENVIRONMENTS.md`](DATABASE_ENVIRONMENTS.md); local dev/test on Docker, production Neon untouched. |
| I | Migration compatibility | DONE | `pnpm test:migrate:fresh` — 10/10 from empty, 70 tables, replay changes no `applied_at`. |
| J | Production database guards | DONE | `packages/database/src/guards.js`; loopback-only TLS exemption cannot apply to Neon. |
| K | Release-grade CI | DONE | CI runs lint, typecheck, build, unit, API, browser, fresh migration, 168 database tests, live journeys, secret scan — all green on `main`. |
| L | Repository security hardening | DONE | Secret scan covers every `apps/*/dist`, the diff and full history; 285 checks clean. |
| M | Formal threat model | DONE | [`../security/THREAT_MODEL.md`](../security/THREAT_MODEL.md) — 12 actors, STRIDE per surface, residual risk per row. |
| N | Authorization matrix | DONE | [`../security/AUTHORIZATION_MATRIX.md`](../security/AUTHORIZATION_MATRIX.md) — capability matrix with an enforcement point and a test per row. |
| O | Privacy & retention | PARTIAL | [`../security/PRIVACY_AND_RETENTION.md`](../security/PRIVACY_AND_RETENTION.md). Retention periods remain open and are flagged for legal review. |
| P | Security headers | DONE | CSP verified live: OSM and CARTO tiles allowed, an unlisted host blocked, Leaflet inline styles allowed. |
| Q | Dependency / supply chain | PARTIAL | Dependabot alerts, security updates and grouped weekly PRs enabled; CodeQL security-extended. SBOM not yet generated. |
| R | Repository protection | DONE | `main` protected (no force-push, no deletion, CI required, admin not locked out); secret scanning and push protection on; `SECURITY.md` added. |
| S | API security hardening | PARTIAL | Anonymous catalogue now rate limited; headers hardened. Per-route audit recorded in the authorization matrix. |
| T | Financial safety | PARTIAL | Webhook authority, replay safety, approval gates and reserve release all tested. No standing ledger-conservation invariant. |
| U | Capacity & concurrency | PARTIAL | `capacity.test.js` covers concurrent oversell on real PostgreSQL. No sustained load test. |
| V | GPS security & scale | PARTIAL | Ingestion authorization, stale rejection and accuracy filtering tested. No server-side per-service write limit; no GPS retention policy. |
| W | Map/routing production strategy | DONE | [`../architecture/MAPS_ROUTING_AND_TRACKING.md`](../architecture/MAPS_ROUTING_AND_TRACKING.md) — canonical; covers rendering, data, providers, limits, fallback. |
| X | Observability | PARTIAL | Structured errors with a requestId, Ops diagnostics, audit trail. No correlation id, no alert routing, no log shipping. |
| Y | SLOs | DONE | [`SLO_AND_MONITORING.md`](SLO_AND_MONITORING.md) — 10 objectives, error budget, severity model, and the measurement gaps named. |
| Z | Database performance | PLANNED | Index review against real access patterns. |
| AA | Load testing | PLANNED | Local/Docker only. |
| AB | Backup & recovery | PLANNED | Documented; restore never tested against production. |
| AC | Data-integrity diagnostics | PLANNED | Safe Platform-Ops invariants. |
| AD | Mass-use UX pass | PLANNED | Real deployed PWA at 360–430 px, tablet, desktop. |
| AE | Accessibility | PLANNED | WCAG 2.1 AA where practical. |
| AF | PWA mass-use quality | PLANNED | Update prompt, stale-version behaviour. |
| AG | Notification scale | PLANNED | Retry/backoff/dead-letter. |
| AH | Identity canonical | DONE | Firebase Authentication + Google Sign-In. ZITADEL was abandoned before any integration; no dual auth system exists. |
| AI | Custom-domain readiness | PLANNED | No architecture rewrite required. |
| AJ | Legal/customer-facing basics | PLANNED | Placeholders, clearly marked for legal review. |
| AK | Support & incident management | PLANNED | Severity, escalation, postmortem. |
| AL | Analytics without surveillance | PLANNED | Aggregate operational events only. |
| AM | Documentation consolidation | DONE | README rewritten (it still described three apps); [`../README.md`](../README.md) index added; `pnpm docs:check` enforces links and indexing. |
| AN | Production readiness checklist | DONE | [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) — 11 sections, every row with evidence or a named action. |
| AO | Release gate | DONE | `pnpm release:check` — 11 gates; a gate that cannot run is reported SKIPPED and fails the check. |
| AP | Final validation | PLANNED | All gates. |
| AQ | Vercel final verification | IN PROGRESS | Canonical projects verified; legacy retirement pending. |
| AR | Secret ownership principle | DONE | Enforced and documented: frontend = public config, API = secrets. |

## Agentic completion

Extends the existing outbox/workflow/approval architecture — no second event
bus, no second authorization model, no direct database access for agents.

| | |
| --- | --- |
| Primary remote model | Gemini Flash (`gemini-3.6-flash`), Google OAuth |
| Authentication | one `authorized_user` ADC document, Sensitive, server-side |
| Fallback | OpenRouter free, low-risk tasks only, named explicitly |
| Local | MiniCPM, for data that must not leave the machine |
| Billing | **DISABLED** on Google Cloud and Firebase, and must remain so |
| Free-tier quota | **LIMITED** — treated as opportunistic, never as a dependency |
| AI criticality | **OPTIONAL / NOT PRODUCT-AUTHORITATIVE** |
| Core product dependency on AI | **NONE** |

| § | Workstream | Status | Evidence |
| --- | --- | --- | --- |
| 1 | No direct DB access for agents | DONE (pre-existing) | Agents act through domain services; verified by `packages/database/tests/agentic.test.js`. |
| 2 | Agent principals | DONE (pre-existing) | `agent_principals`, `agent_scopes` (migration 006), `lragt_…` tokens stored as digests. |
| 3 | Scopes | DONE | Scopes enforced server-side per action; operator binding holds across every scope. |
| 4 | Action catalog | DONE (pre-existing) | `packages/agents/src/actions.js` — typed, schema-validated, no free-form commands. |
| 5 | Risk classes | DONE (pre-existing) | `read` / `low_risk` / `privileged` / `financial`. |
| 6 | Domain events | DONE (pre-existing) | Single outbox; no second event system. |
| 7 | Workflow engine | DONE (pre-existing) | `packages/agents/src/workflows.js` — trigger, steps, retries, approval, audit. |
| 8 | Service delay agent | PARTIAL | `delay-management` notifies and surfaces; `incident-triage` adds model-assisted classification behind a deterministic threshold. ETA recalculation still derives from the tracking endpoint on read. |
| 9 | Breakdown/recovery agent | DONE (pre-existing) | `breakdown-recovery`, Ops approval required. |
| 10 | Passenger journey agent | IN PROGRESS | First-mile recomputation exists; reminder suppression to verify. |
| 11 | Payment agent | DONE (pre-existing) | `payment-reconciliation`, approval-gated, cannot fabricate success. |
| 12 | Payout agent | DONE (pre-existing) | `driver-payout`, approval required by default. |
| 13 | Parcel agent | DONE | `parcel-delay`, `parcel-exception`, `parcel-breakdown`, `parcel-uncollected-*`. |
| 14 | Uncollected parcel workflow | DONE | Thresholds configurable; clock runs from the `ready_for_pickup` event; each stage fires once per arrival. Tested. |
| 15 | Notification agent | IN PROGRESS | Channel availability honest; retry/dead-letter to complete. |
| 16 | Ops copilot experience | PLANNED | Proactive summaries with evidence and action. |
| 17 | Explainability | DONE | Stored: classification, severity, one-sentence reason, proposed action, provider, model, latency, validation result. Never a reasoning trace — `thinkingBudget: 0`, measured at 0 thought tokens. |
| 18 | Human approval queue | DONE (pre-existing) | `workflow_approvals`, exactly-once decisions. |
| 19 | Agent failure behaviour | DONE | Domain transaction safety independent of agent availability. Tested with Gemini quota-exhausted: booking, cancellation and the deterministic recovery workflow are untouched, and nothing reaches a passenger. |
| 20 | Idempotency | DONE (pre-existing) | `agent_action_receipts`, one open run per (workflow, aggregate, trigger). |
| 21 | Audit | DONE (pre-existing) | `audit_events` for every agent mutation. |
| 22 | Agentic threat model | DONE | Agentic surface section of `THREAT_MODEL.md`. |
| 23 | Prompt-injection defence | DONE | Structural: no free-form command path. Test asserts injected payload text creates no action. |
| 24 | Data minimization | DONE | Allowlist projections, proven by `unsafeFields()` rather than trusted. Never a name, phone, coordinate, pickup code or payout destination. |
| 25 | Model provider abstraction | DONE | [`../architecture/MODEL_PROVIDERS.md`](../architecture/MODEL_PROVIDERS.md) — Gemini Flash (primary, OAuth), OpenRouter (named fallback), local MiniCPM, none. An unrecognised name selects nothing, and the fallback is never inferred from a key. |
| 26 | Deterministic before generative | DONE | No invariant lives in a prompt. A booking completes through payment while the provider throws on every call. |
| 27 | Cost control | DONE | Daily and per-workflow ceilings in the database, duplicate suppression by input fingerprint, and a **shared** cooldown after a quota error that honours Google's own `Retry-After`. Never called on routine events; a deterministic threshold gates the one workflow that asks. |
| 28 | Agent observability | PARTIAL | `agent_model_calls` records the provider that *answered*, the one it fell back from (013), whether quota was exhausted and the window it ends in (014), task, requested and actual model, status and latency. `ops/model-usage` aggregates today. No historical dashboard yet. |
| 29 | Agentic UI status | IN PROGRESS | Ops shows recommendation/approval states. |
| 30 | Multi-tenancy | DONE (pre-existing) | Operator binding enforced server-side and tested. |
| 31 | Offline operations | DONE (pre-existing) | Crew queue syncs, then domain events fire. |
| 32 | Agentic support | PARTIAL | `incident.triage` and `parcel.triage` exist with narrow menus, and `incident-triage` now wires triage into a real workflow at `recommend` autonomy. No customer-facing assistant, by design. |
| 33 | Agentic pilot mode | DONE | `observe` autonomy: reads run, mutations are recorded as proposals, run completes, `workflow.step_observed` audited. |
| 34 | Autonomy policy | DONE | Per-workflow autonomy; an unrecognised value resolves to the safest level, never the loosest. |
| 35 | Agentic tests | PARTIAL | 83 model tests plus 26 agentic tests, covering OAuth refresh, credential atomicity, retry metadata, shared cooldown, fallback and the wired workflow. No test reaches a provider: the Gemini suite makes a real network call fail. Load cases outstanding. |
| 36 | Agentic load/scale | PLANNED | Local/Docker only. |
| 37 | Agentic documentation | DONE | `AGENTIC_WORKFLOWS.md` extended with autonomy, untrusted content and the parcel workflows. |
| 38 | Agentic readiness gate | DONE | Section 7 of `PRODUCTION_READINESS.md`. |

## USSD channel

| Area | Status | Evidence |
| --- | --- | --- |
| Architecture | DONE | Channel over the same domain; no second booking engine, capacity rule or payment truth. |
| Provider adapter | DONE | Sandbox and generic HMAC; an unknown provider resolves to no adapter. |
| Journeys | DONE | Search, booking, payment handoff, bookings, journey status, parcel tracking, help, language. |
| Safety | DONE | Verification, replay suppression, session expiry, per-caller throttle, hashed phone numbers. |
| Identity | DONE | Binds an existing passenger only, on a verified callback, with trust opt-in. No creation, no promotion. |
| Tests | DONE | 22 unit, 9 webhook, 26 journey — including web-vs-USSD concurrency for the last seat. |
| Live provider | BLOCKED_EXTERNAL | No Benin gateway selected; no shortcode provisioned. |

## Decisions worth carrying

- **PostgreSQL 18 locally** because production Neon reports 18.6. Testing
  migrations on an older major version would prove less than it appears to.
- **TLS is exempted only for loopback hosts**, decided from the URL rather than
  a flag, so no environment variable can disable verification for Neon.
- **`docker/postgres.env` is committed on purpose.** It addresses a container
  that exists only on a developer's machine, and committing it is what makes
  the isolated path the easy path. It is deliberately not named `.env.*`,
  because the secret scanner fails on any tracked file with that prefix, and
  that rule must stay absolute.
- **USSD binds, never creates.** A gateway MSISDN proves the gateway sent it,
  not that the caller owns the account. So USSD reuses an account created
  through the real sign-in path and offers anonymous journeys otherwise —
  rather than minting identities from an unauthenticated claim.
- **One booking is one seat**, because the domain models it that way. Asking a
  USSD caller for a passenger count would offer a capability the product does
  not have.
- **One maps document.** `MAPS_ROUTING_AND_TRACKING.md` is canonical; a second
  `MAPS_AND_ROUTING.md` would be the documentation equivalent of a parallel
  architecture.
