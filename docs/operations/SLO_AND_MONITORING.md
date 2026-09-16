# Service objectives and monitoring

What LeRoutier promises to be, how that is measured, and what happens when it
is not met.

> These are **initial pilot objectives**, set to be met and then tightened —
> not marketing numbers. Every target below is achievable with the current
> architecture. Where a number cannot yet be measured, it says so rather than
> being asserted.

## Why these and not others

A transport platform fails in ways a website does not. A five-second page is an
annoyance; a passenger who reaches a station after the bus left has lost their
day. So the objectives below weight **timeliness of operational truth** above
raw availability, and the strictest target in the document is the one on
payment webhooks — because that is where someone's money sits in limbo.

## Objectives

| # | Objective | Target | Window | Measured from |
| --- | --- | --- | --- | --- |
| 1 | API availability (non-5xx on `/api/v1`) | **99.5 %** | 30 days | platform request logs |
| 2 | Trip search responds | **p95 < 1.5 s** | 7 days | request duration |
| 3 | Booking hold responds | **p95 < 2.0 s** | 7 days | request duration |
| 4 | **Payment webhook processed** | **p95 < 30 s** from provider send | 7 days | provider timestamp → payment state change |
| 5 | Payment reaches a terminal state | **99.9 %** within 15 min | 30 days | `payments` age in a pending state |
| 6 | GPS freshness on an active service | **≥ 90 %** of active minutes have a fix < 5 min old | 7 days | `vehicle_positions` vs active services |
| 7 | Notification dispatched | **p95 < 60 s** from its domain event | 7 days | `outbox.created_at` → delivery row |
| 8 | Workflow run completes or pauses | **p95 < 5 min** from trigger | 7 days | `workflow_runs` timestamps |
| 9 | Crew offline queue drains | **p95 < 2 min** after connectivity returns | 7 days | client queue telemetry — **not yet instrumented** |
| 10 | Parcel status reflects reality | **≥ 99 %** of scans visible within 60 s | 7 days | `parcel_events` → tracking read |

### Deliberate non-objectives

- **No uptime target for map tiles or routing.** Both are third-party and both
  degrade honestly by design: no tiles still renders stops, no routing still
  gives stops and a schedule-based ETA. Making them an SLO would imply a
  control LeRoutier does not have.
- **No target on ETA accuracy.** The estimate states its own confidence and is
  rounded to five minutes precisely because the inputs do not support a
  stronger claim. An accuracy SLO would invite the fabrication the whole design
  avoids.

## Error budget

Objective 1 at 99.5 % over 30 days allows roughly **3 h 39 m** of failure.

| Budget spent | What changes |
| --- | --- |
| < 50 % | normal delivery |
| 50–100 % | reliability work takes priority over new features |
| exhausted | feature work pauses; only fixes, and a written cause |

## What is watched

### Already emitted

- `LR_API_ERROR <method> <path> <code> <message>` — unexpected server errors,
  code and message only. **No connection string, no credential, no payload.**
- Every error response carries a `requestId`, so a user's report maps to a log
  line without the user quoting anything sensitive.
- `GET /api/v1/ops/diagnostics` — machine-readable counts, Ops-scoped, no party
  data: failed payments, 7-day payment anomalies, failed and processing
  payouts, open incidents, **services with stale tracking**, failed and
  awaiting-approval workflows, open parcel exceptions, uncollected parcels.
- `audit_events` — who did what, including every agent mutation and approval.
- `workflow_runs` / `workflow_approvals` — agent execution, retries, approval
  rate and human override.

### Gaps, stated plainly

| Gap | Consequence |
| --- | --- |
| No correlation id propagated from browser → API → workflow | a slow journey cannot be followed end to end |
| Logs are not shipped anywhere queryable | history is the platform's retention window |
| No alert routing — diagnostics must be *looked at* | a failure at 02:00 waits until someone opens the console |
| No client-side telemetry for the offline queue (objective 9) | that objective cannot currently be measured |
| No latency histograms of our own | objectives 2, 3, 7 and 8 rely on platform metrics |

These are the observability work still outstanding, tracked in
[`MASTER_PRODUCT_COMPLETION.md`](MASTER_PRODUCT_COMPLETION.md) §X.

## Logging rules

Absolute, and worth restating because a breach here is a privacy incident:

- **Never** a credential, token, connection string, API key, or webhook secret.
- **Never** a full request or response body.
- **No PII by default** — no phone numbers, no names, no coordinates. An entity
  id is enough to join to the data under proper authorization.
- Errors log a code and a message. Driver-level errors are never surfaced.
- **Agent prompt content is not logged.** There is no model on a critical path
  today; when one is added, the metric is the outcome, not the content.

## Responding

| Signal | First check | Runbook |
| --- | --- | --- |
| Health failing | is the database reachable | [`RUNBOOKS.md`](RUNBOOKS.md) |
| Payments stuck pending | webhook signature failures, provider status | [`RUNBOOKS.md`](RUNBOOKS.md) |
| Payouts failed | reserved balance released? | [`RUNBOOKS.md`](RUNBOOKS.md) |
| Stale tracking on active services | crew device foregrounded? network? | [`MAPS_ROUTING_AND_TRACKING.md`](../architecture/MAPS_ROUTING_AND_TRACKING.md) |
| Workflows failed or awaiting approval | the Ops approval queue | [`AGENTIC_WORKFLOWS.md`](../architecture/AGENTIC_WORKFLOWS.md) |
| Uncollected parcels climbing | station capacity, receiver contact | [`PARCEL_LOGISTICS.md`](../architecture/PARCEL_LOGISTICS.md) |

## Incident severity

| Sev | Meaning | Examples | Response |
| --- | --- | --- | --- |
| **SEV1** | passengers cannot travel, or money is at risk | auth outage, payment provider down, database unavailable, duplicate charges | immediate; owner engaged; customer notice |
| **SEV2** | a core journey is degraded | tracking blind across the fleet, notifications not dispatching, parcel scans failing | same working day |
| **SEV3** | a single operator or service affected | one crew device without GPS, one stuck payout | next working day |
| **SEV4** | cosmetic or internal | a stale document, a noisy log | scheduled |

Every SEV1 and SEV2 gets a written cause: **what happened, what the system did,
what it should have done, and what changes.** A postmortem that assigns blame
to a person rather than to a control has not been completed.

Customer communication during an incident follows the same rule as the product:
say what is known, say what is not, and never claim a state the system cannot
observe.
