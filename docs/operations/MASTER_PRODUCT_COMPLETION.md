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
| K | Release-grade CI | IN PROGRESS | Postgres service container + fresh-migration + database suite + secret scan. |
| L | Repository security hardening | IN PROGRESS | Secret scan now covers every `apps/*/dist` including the canonical PWA. |
| M | Formal threat model | PLANNED | `docs/security/THREAT_MODEL.md`. |
| N | Authorization matrix | PLANNED | Server-enforced, test-backed. |
| O | Privacy & retention | PLANNED | `docs/security/PRIVACY_AND_RETENTION.md`. |
| P | Security headers | PLANNED | Must not break OIDC, tiles, FedaPay redirect, API rewrite. |
| Q | Dependency / supply chain | PLANNED | Audit, Dependabot, SBOM. |
| R | Repository protection | PLANNED | `SECURITY.md`; branch protection documented if not applicable. |
| S | API security hardening | PLANNED | Per-route audit of `/api/v1`. |
| T | Financial safety | PLANNED | Ledger conservation invariants. |
| U | Capacity & concurrency | PLANNED | Oversell invariant under concurrency, on Docker. |
| V | GPS security & scale | PLANNED | Ingestion authorization, retention, indexes. |
| W | Map/routing production strategy | DONE | [`../architecture/MAPS_ROUTING_AND_TRACKING.md`](../architecture/MAPS_ROUTING_AND_TRACKING.md) — canonical; covers rendering, data, providers, limits, fallback. |
| X | Observability | PLANNED | Structured logs, correlation IDs, no PII. |
| Y | SLOs | PLANNED | `docs/operations/SLO_AND_MONITORING.md`. |
| Z | Database performance | PLANNED | Index review against real access patterns. |
| AA | Load testing | PLANNED | Local/Docker only. |
| AB | Backup & recovery | PLANNED | Documented; restore never tested against production. |
| AC | Data-integrity diagnostics | PLANNED | Safe Platform-Ops invariants. |
| AD | Mass-use UX pass | PLANNED | Real deployed PWA at 360–430 px, tablet, desktop. |
| AE | Accessibility | PLANNED | WCAG 2.1 AA where practical. |
| AF | PWA mass-use quality | PLANNED | Update prompt, stale-version behaviour. |
| AG | Notification scale | PLANNED | Retry/backoff/dead-letter. |
| AH | OIDC canonical | BLOCKED_EXTERNAL | Provider choice and credentials are the owner's. |
| AI | Custom-domain readiness | PLANNED | No architecture rewrite required. |
| AJ | Legal/customer-facing basics | PLANNED | Placeholders, clearly marked for legal review. |
| AK | Support & incident management | PLANNED | Severity, escalation, postmortem. |
| AL | Analytics without surveillance | PLANNED | Aggregate operational events only. |
| AM | Documentation consolidation | PLANNED | README must describe one PWA. |
| AN | Production readiness checklist | PLANNED | `docs/operations/PRODUCTION_READINESS.md`. |
| AO | Release gate | PLANNED | `pnpm release:check`. |
| AP | Final validation | PLANNED | All gates. |
| AQ | Vercel final verification | IN PROGRESS | Canonical projects verified; legacy retirement pending. |
| AR | Secret ownership principle | DONE | Enforced and documented: frontend = public config, API = secrets. |

## Agentic completion

Extends the existing outbox/workflow/approval architecture — no second event
bus, no second authorization model, no direct database access for agents.

| § | Workstream | Status | Evidence |
| --- | --- | --- | --- |
| 1 | No direct DB access for agents | DONE (pre-existing) | Agents act through domain services; verified by `packages/database/tests/agentic.test.js`. |
| 2 | Agent principals | DONE (pre-existing) | `agent_principals`, `agent_scopes` (migration 006), `lragt_…` tokens stored as digests. |
| 3 | Scopes | IN PROGRESS | Existing scope list; extension for tracking/parcel scopes under review. |
| 4 | Action catalog | DONE (pre-existing) | `packages/agents/src/actions.js` — typed, schema-validated, no free-form commands. |
| 5 | Risk classes | DONE (pre-existing) | `read` / `low_risk` / `privileged` / `financial`. |
| 6 | Domain events | DONE (pre-existing) | Single outbox; no second event system. |
| 7 | Workflow engine | DONE (pre-existing) | `packages/agents/src/workflows.js` — trigger, steps, retries, approval, audit. |
| 8 | Service delay agent | IN PROGRESS | `delay-management` exists; ETA recalculation integration pending. |
| 9 | Breakdown/recovery agent | DONE (pre-existing) | `breakdown-recovery`, Ops approval required. |
| 10 | Passenger journey agent | IN PROGRESS | First-mile recomputation exists; reminder suppression to verify. |
| 11 | Payment agent | DONE (pre-existing) | `payment-reconciliation`, approval-gated, cannot fabricate success. |
| 12 | Payout agent | DONE (pre-existing) | `driver-payout`, approval required by default. |
| 13 | Parcel agent | IN PROGRESS | `parcel-delay`, `parcel-exception`, `parcel-breakdown` exist. |
| 14 | Uncollected parcel workflow | PLANNED | Thresholds must be configurable, never invented. |
| 15 | Notification agent | IN PROGRESS | Channel availability honest; retry/dead-letter to complete. |
| 16 | Ops copilot experience | PLANNED | Proactive summaries with evidence and action. |
| 17 | Explainability | PLANNED | Operational reasons, never chain-of-thought. |
| 18 | Human approval queue | DONE (pre-existing) | `workflow_approvals`, exactly-once decisions. |
| 19 | Agent failure behaviour | DONE (pre-existing) | Domain transaction safety independent of agent availability. |
| 20 | Idempotency | DONE (pre-existing) | `agent_action_receipts`, one open run per (workflow, aggregate, trigger). |
| 21 | Audit | DONE (pre-existing) | `audit_events` for every agent mutation. |
| 22 | Agentic threat model | PLANNED | Section of `THREAT_MODEL.md`. |
| 23 | Prompt-injection defence | PLANNED | Untrusted free text must never become policy. |
| 24 | Data minimization | PLANNED | Safe structured projections. |
| 25 | Model provider abstraction | PLANNED | Interface only; deterministic workflows stay deterministic. |
| 26 | Deterministic before generative | DONE | No LLM is on any critical path today; invariants are code. |
| 27 | Cost control | PLANNED | Invocation/token/retry limits. |
| 28 | Agent observability | PLANNED | Execution, retry, approval and override metrics. |
| 29 | Agentic UI status | IN PROGRESS | Ops shows recommendation/approval states. |
| 30 | Multi-tenancy | DONE (pre-existing) | Operator binding enforced server-side and tested. |
| 31 | Offline operations | DONE (pre-existing) | Crew queue syncs, then domain events fire. |
| 32 | Agentic support | PLANNED | Constrained; never a general chatbot. |
| 33 | Agentic pilot mode | PLANNED | Observe/recommend before autonomy. |
| 34 | Autonomy policy | PLANNED | Per-workflow autonomy level. |
| 35 | Agentic tests | IN PROGRESS | Existing coverage in `agentic.test.js`; 20-point list being completed. |
| 36 | Agentic load/scale | PLANNED | Local/Docker only. |
| 37 | Agentic documentation | IN PROGRESS | `AGENTIC_WORKFLOWS.md` exists and is being extended. |
| 38 | Agentic readiness gate | PLANNED | Section of the production gate. |

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
- **One maps document.** `MAPS_ROUTING_AND_TRACKING.md` is canonical; a second
  `MAPS_AND_ROUTING.md` would be the documentation equivalent of a parallel
  architecture.
