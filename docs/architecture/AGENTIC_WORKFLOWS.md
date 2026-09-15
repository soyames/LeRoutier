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

The FedaPay webhook emits `payment.anomaly` / `payout.anomaly` only for
signature-valid events that fail strict correlation, so anomalies are always
real and never attacker-controlled.

## Event catalog (outbox)

`booking.held/confirmed/boarded/completed/cancelled/expired`, `payment.pending/
succeeded/failed/cancelled/refunded/anomaly`, `payout.requested/processing/
paid/failed/cancelled/reversed/anomaly`, `incident.created/updated`,
`service.status/advanced/position/recovery`, `earning.credited`,
`notification.send`, `alert.created`.
