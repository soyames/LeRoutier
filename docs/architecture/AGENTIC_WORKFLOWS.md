# Agentic Workflows

LeRoutier is an agentic platform: operational workflows can be automated
safely through the same versioned API and domain services used by the
Passenger, Driver and Ops applications. Agents have **no direct database
access** — every mutation goes through the shared domain layer and is audited.

## Identity model

Service/agent principals are distinct from human users and never impersonate
Ops. A principal has:

- a **name** and an **opaque token** (`lragt_…`), stored only as a SHA-256 digest;
- an explicit **scope list** (see below);
- an optional **operator binding** — a principal bound to one operator can
  never read or mutate another operator's data (platform principals without a
  binding are documented and audited).

Provision principals with the CLI bootstrap (`scripts/agent-bootstrap.mjs`,
reading `AGENT_BOOTSTRAP_JSON` from an ignored env file). Tokens are sent as
`Authorization: Bearer lragt_…` to `/api/v1/agent/…` only.

### Permission scopes

| Scope | Grants |
| --- | --- |
| `service.read` | Inspect services, capacity, route summaries |
| `incident.read` | Inspect open incidents, propose recoveries |
| `incident.manage` | Assign replacement vehicles (approval required) |
| `notification.send` | Queue passenger notifications |
| `payment.reconcile` | Inspect and reconcile FedaPay collections (approval required) |
| `payout.review` | Inspect payout requests, execute payouts (approval required), escalate anomalies |
| `alert.create` | Create operational alerts for the Ops dashboard |
| `workflow.run` | Trigger the outbox/workflow tick |

## Action model

Every agent action is typed and structured (`packages/agents/src/actions.js`):

- **name** (`service.inspect`, `payment.reconcile`, `payout.execute`, …);
- **category** — `read`, `low_risk`, `privileged`, `financial`;
- **required scope**;
- **input/output schemas** (strictly validated, no extra fields);
- **approval** — `never` or `always`;
- **idempotency** — an optional `Idempotency-Key` replays the stored receipt;
- **audit** — every request, step, approval and result is written to
  `audit_events` / `workflow_runs` / `workflow_approvals`.

Actions are exposed under `/api/v1/agent/actions/{name}/run`
(`GET /api/v1/agent/actions` lists the catalog filtered by the principal's
scopes). Read and low-risk actions execute immediately; privileged and
financial actions create a pending approval.

## Human-in-the-loop

Financial and high-impact operations **never execute silently**:

| Action | Category | Approval |
| --- | --- | --- |
| `recovery.assign` (vehicle replacement) | privileged | always |
| `payment.reconcile` | financial | always |
| `payout.execute` (send driver money) | financial | always |

A pending approval pauses the workflow run (`awaiting_approval`). Ops decides
through `/api/v1/agent/approvals` (or the Ops console): **exactly once** — a
second decision on the same approval is rejected. On approval, the step
executes under the identity of the deciding Ops operator (the agent is never
an Ops user), and the approved input may be revised by Ops before execution.
The driver payout flow (`/api/v1/ops/payouts/{id}/approve`) follows the same
principle and is configured via `PAYOUT_APPROVAL_REQUIRED` (default: required).

Nothing in the Ops console can fabricate a provider success event. Manual
reconciliation (`/api/v1/bookings/{id}/reconcile-manual`) remains an
ops-privileged, audited operation.

## Workflow engine

A lightweight engine (`packages/agents/src/workflows.js`) runs over the
existing **outbox/audit** architecture — no BPM platform:

- **trigger**: a domain event from the outbox (`incident.created`,
  `payment.anomaly`, `payout.requested`, `service.position`, …);
- **conditions/steps**: ordered steps (engine-local or catalog actions);
- **retries**: failed runs are retried up to 3 times via
  `/api/v1/workflows/{id}/retry` (Ops);
- **idempotency**: one open run per `(workflow, aggregate, trigger)`; domain
  services keep their own receipts, so replays never duplicate mutations;
- **status**: `running → awaiting_approval → completed | failed | cancelled`;
- **audit**: run lifecycle events in `audit_events`.

The tick runs as `POST /api/v1/workflows/tick` (agent scope `workflow.run`;
suitable for Vercel Cron) or via `services/worker` (`pnpm --filter
@leroutier/worker workflows`). It consumes undelivered outbox events, creates
guarded runs and drives steps.

## Autonomy

How much a workflow may do without a human is **configuration, not code** — and
deliberately not one global switch, because "turn autonomy on" is exactly the
decision that should never be made once, for everything, in one place.

| Level | The agent may |
| --- | --- |
| `observe` | read and record what it *would* do; mutate nothing |
| `recommend` | read; every mutating step becomes an approval request |
| `auto_low_risk` | run read and low-risk steps; privileged and financial steps still wait |
| `approval_required` | nothing without a human, reads included |

Resolution order is explicit configuration → the workflow's declared default →
the global default (`auto_low_risk`). Two rules make this fail safe:

- An **unrecognised value is treated as the safest level, never the loosest.** A
  typo in `AGENT_AUTONOMY_DEFAULT` falls back to `auto_low_risk`; a typo in a
  per-workflow entry pins *that* workflow to `observe`. Malformed JSON widens
  nothing.
- Autonomy is applied **once, centrally**, in the engine — not scattered through
  the definitions, where a single omission would quietly become an exception.

Observation mode is how recommendation quality gets measured before autonomy is
widened: steps that only read still execute, everything else is recorded as
`observed` with the input it would have used, the run completes, and
`workflow.step_observed` lands in the audit log. Nothing changed, and the
proposal is reviewable.

```bash
AGENT_AUTONOMY_DEFAULT=observe                          # whole layer observes
AGENT_AUTONOMY='{"driver-payout":"approval_required"}'  # tighten one workflow
```

Existing approval gates are unchanged by any of this: money and privileged
operational change wait for a human at every level.

### Built-in workflows

- **payment-reconciliation** — `payment.anomaly` → propose a trusted
  reconciliation of the mismatched provider event → Ops approval → reconcile.
- **breakdown-recovery** — `incident.created` → find eligible replacement
  vehicles and count affected passengers → Ops approval (vehicle/driver
  revisable) → assign → notify affected passengers.
- **driver-payout** — `payout.requested` → validate the reserved ledger
  balance → Ops approval → execute through the payout provider → provider
  status reconciles the request.
- **delay-management** — `service.position` → if a delay incident is open,
  raise an operational alert for Ops.
- **payout-anomaly** — `payout.anomaly` → raise an operational alert.
- **parcel-delay**, **parcel-exception**, **parcel-breakdown** — detect parcels
  on a delayed or broken-down service, notify receivers, and propose a
  reassignment for Ops approval.
- **parcel-uncollected-reminder / -escalation** — a parcel that arrived and was
  never collected. Thresholds are configuration
  (`PARCEL_UNCOLLECTED_REMINDER_HOURS`, `PARCEL_UNCOLLECTED_ESCALATION_HOURS`,
  default 24 / 72 hours); the clock runs from the `ready_for_pickup` event
  rather than the parcel's `updated_at`, so correcting a note does not make an
  uncollected parcel look fresh. Each stage fires once per arrival, and a
  parcel returned to the counter later legitimately starts a new cycle.

Time-based workflows have **no second scheduler**. The sweep in
`packages/database/src/reminders.js` raises ordinary outbox events, which then
travel the same policy → recipient → channel path as everything else.

## Untrusted content

Passenger notes, parcel notes, operator names, incident notes and station
descriptions are **data, never instructions**. The structural defence is that
there is nothing for an injected instruction to call: the only execution path is
a typed catalog with validated schemas, and no free-form command endpoint
exists. An event payload carrying `"action":"payout.execute"` and a persuasive
note changes nothing — covered by test in `packages/database/tests/agentic.test.js`.

Deterministic before generative: capacity, fares, payment state, payout
eligibility, permissions, geometry and state machines are code. No invariant
lives in a prompt. **No model is on any critical path today**, so a model
failure cannot affect booking or payment safety.

The FedaPay webhook emits `payment.anomaly` / `payout.anomaly` only for
signature-valid events that fail strict correlation, so anomalies are always
real and never attacker-controlled.

## Event catalog (outbox)

`booking.held/confirmed/boarded/completed/cancelled/expired`, `payment.pending/
succeeded/failed/cancelled/refunded/anomaly`, `payout.requested/processing/
paid/failed/cancelled/reversed/anomaly`, `incident.created/updated`,
`service.status/advanced/position/recovery`, `earning.credited`,
`notification.send`, `alert.created`.
