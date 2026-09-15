# API Versioning

LeRoutier exposes one versioned HTTP API. The transport contract is versioned;
the domain services, database logic and business rules are not.

## Rule: `/api/v1` prefix

Every endpoint lives under `/api/v1`:

| Endpoint | Purpose |
| --- | --- |
| `/api/v1/health` | Liveness + database probe |
| `/api/v1/auth/config` | Public OIDC configuration |
| `/api/v1/auth/demo` | Development-only demo sessions |
| `/api/v1/me` | Current identity (profile updates via `PATCH`) |
| `/api/v1/bookings`, `/api/v1/bookings/{id}/…` | Holds, confirmations, boarding |
| `/api/v1/bookings/{id}/payment-intents` | Provider payment initiation (server-authoritative amount) |
| `/api/v1/bookings/{id}/payment-status` | Trusted payment state for a booking |
| `/api/v1/bookings/{id}/ticket` | Boarding QR/ticket issuance |
| `/api/v1/payments/{id}/reconcile` | Trusted provider reconciliation |
| `/api/v1/driver/…` | Driver console (service, actions, earnings, payouts) |
| `/api/v1/ops/…` | Ops console (provisioning, fleet, payments, payouts) |
| `/api/v1/incidents` | Incident reporting and lifecycle |
| `/api/v1/tickets/verify` | Boarding QR/code verification |
| `/api/v1/webhooks/fedapay` | Dedicated LeRoutier FedaPay webhook (see `AGENTIC_WORKFLOWS.md` and the FedaPay integration notes) |
| `/api/v1/agent/…` | Agent API (service principals, scoped actions, approvals) |
| `/api/v1/workflows/…` | Workflow runs, retries and the outbox tick |

No new unversioned production endpoint may be added.

## Compatibility policy

Unversioned paths (`/health`, `/bookings`, …) are temporarily aliased to their
`/api/v1` equivalent and run the **exact same handler** — never duplicated
business logic. Every aliased response carries:

```
Deprecation: true
Sunset: 2026-12-31T23:59:59Z
```

The aliases will be removed after the sunset date. Frontend apps, the USSD
client and tests must migrate to `/api/v1` immediately (they have).

## Future breaking versions

A breaking transport change gets a new major prefix (`/api/v2`) and its own
compatibility window. The FedaPay webhook contract follows the same scheme:
the current endpoint is `/api/v1/webhooks/fedapay`; a future breaking webhook
contract becomes `/api/v2/webhooks/fedapay` — never a second parallel
versioning scheme. The FedaPay dashboard endpoint must be updated by an
operator at that time (the webhook is account-level and unique to LeRoutier).

## Invariants

- Domain services (`packages/domain`, `packages/database`) are never
  versioned or forked. Only `services/api` maps routes to them.
- One handler per operation: version aliases call the same code path.
- All response bodies are wrapped in `{ data }` / `{ error: { code, message,
  requestId } }`; errors never leak internals.
