# Pilot Rollout Checklist

Controlled real-world pilot preparation for LeRoutier. Run through this list
in order; every step is executable through the Ops console or the documented
CLIs — no direct database manipulation. Never put secret values in this
document or in chat.

## 0. Production configuration reference

The API (`le-routier-api` on Vercel) expects exactly these environment
variables. Server-only; nothing is prefixed with `VITE_*`.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon PostgreSQL, SSL required |
| `DATABASE_SCHEMA` | no | defaults to `leroutier` |
| `CORS_ORIGINS` | yes | comma-separated exact frontend origins (no wildcards) |
| `AUTH_ISSUER` / `AUTH_JWKS_URL` / `AUTH_AUDIENCE` | yes for sign-in | production fails closed until all three are valid HTTPS |
| `OIDC_CLIENT_ID` / `OIDC_SCOPE` / `OIDC_REDIRECT_URIS` | yes for sign-in | public PKCE client; redirect URIs must end `/auth/callback` per app |
| `OIDC_RESOURCE` | optional | provider-specific |
| `PAYMENT_PROVIDER` | `fedapay` | enables collections |
| `FEDAPAY_ENVIRONMENT` | `live` | production never falls back to sandbox |
| `FEDAPAY_SECRET_KEY` | yes for collections | FedaPay dashboard API key |
| `FEDAPAY_WEBHOOK_SECRET` | yes for webhooks | per-endpoint secret (Workbench → Webhooks), distinct from the API key |
| `FEDAPAY_PAYOUT_SECRET_KEY` | for payouts | separate variable; payouts fail closed without it |
| `PAYOUT_APPROVAL_REQUIRED` | recommended `true` | Ops must approve every withdrawal |
| `ALLOW_DEMO_LOGIN` | never in production | demo login is disabled automatically on Vercel |

`FEDAPAY_PUBLIC_KEY` is **not used**: LeRoutier uses the server-side redirect
flow (transaction + token), not the client-side Checkout.js integration.

Verify live state without touching secrets:
`GET /api/v1/payments/config` → `{available:true, payouts:{available:true}}`.

## 1. Database schema — done (2026-09-16)

Migrations are never applied automatically on deploy, and nothing below works
until the production schema is current. `DATABASE_URL` is a **Sensitive**
Vercel variable, so it cannot be pulled with the CLI — copy it from the Vercel
or Neon dashboard into a git-ignored `.env.production.local` alongside
`DATABASE_SCHEMA=leroutier`. Production and development share one Neon
database and differ only by schema, so the schema *is* the environment. See
"Data routes return 503 after a deploy" in `RUNBOOKS.md`.

- [x] `status.js` against production reports `No demo identities` (never run a
  migration against a target that reports demo identities — that is the
  development schema).
- [x] `migrate.js` reports "Migrations validated: 9".
- [x] `status.js` reports `9/9 applied; 0 declared table(s) absent`.
- [x] `validate.js` passes replay, checksums and occupation invariants.
- [x] `pnpm smoke:prod` passes 14/14.
- [x] Delete `.env.production.local`.

Applying migrations created empty tables plus reference configuration only
(6 parcel categories, 52 notification policies, 1 mobility provider). No
operator, route, service, vehicle, driver, passenger or parcel was seeded —
every row below is created through the real onboarding and Ops flows.

## 2. Auth provider setup

- [ ] Configure the OIDC provider (issuer, JWKS URL, audience).
- [ ] Register one public PKCE client per app (Passenger/Driver/Ops).
- [ ] Set callback URLs exactly: `https://le-routier-passenger.vercel.app/auth/callback`, same for `-driver` and `-ops`.
- [ ] Set `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URIS` on `le-routier-api`.
- [ ] `GET /api/v1/auth/config` returns an OIDC block and `demoLogin:false`.

## 3. Bootstrap the first operator

Use the one-time CLI (`packages/database/scripts/bootstrap.js`) with an
ignored env file on your machine. Required values: `BOOTSTRAP_CONFIRM=provision-first-operator`,
`AUTH_ISSUER`, `BOOTSTRAP_OPERATOR_KEY`, `BOOTSTRAP_OPERATOR_NAME`,
`BOOTSTRAP_OPS_SUBJECT`, `BOOTSTRAP_OPS_NAME` (optional:
`BOOTSTRAP_PLATFORM_OPS`, driver fields). The bootstrap:

- [ ] creates the first operator and the first Ops identity,
- [ ] is idempotent — a rerun with identical inputs verifies and exits,
- [ ] refuses to run once privileged users exist (use normal provisioning after),
- [ ] writes `operator.bootstrapped` / `identity.ops_bootstrapped` audit events,
- [ ] never prints identifiers or secrets.

Then sign in to the Ops app with the bootstrapped identity.

## 4. Pilot network (all through the Ops console)

- [ ] Create places (cities) and stops along the corridor.
- [ ] Create the route with ordered stops and segment fares.
- [ ] Create one vehicle (capacity ≥ planned pilot load).
- [ ] Create the pilot driver (`/api/v1/ops/drivers`), then assign driver +
  vehicle to a scheduled service.
- [ ] Create the first service (route + vehicle + driver + departure).
- [ ] Create a parcel rate rule (`/api/v1/ops/parcel-rate-rules`) — parcels
  cannot be created without an explicit rule (fail-closed pricing).

## 5. Payments

- [ ] Confirm `GET /api/v1/payments/config` shows collections available.
- [ ] FedaPay dashboard: webhook #8590 enabled, URL
  `https://le-routier-api.vercel.app/api/v1/webhooks/fedapay`, secret stored
  in Vercel `FEDAPAY_WEBHOOK_SECRET` (distinct per endpoint, sandbox vs live differ).
- [ ] Send one FedaPay test webhook event from the dashboard; it must be
  answered 200 and appear as an anomaly or ignored event (never a charge).
- [ ] **Payouts**: confirm with FedaPay that Payouts is activated on the
  account; `FEDAPAY_PAYOUT_SECRET_KEY` set; `PAYOUT_APPROVAL_REQUIRED=true`.
  No real payout is sent during validation.

## 6. First real pilot runs (one at a time, watched)

- [ ] One passenger booking: search → hold → FedaPay checkout → webhook
  confirms → boarding QR issued.
- [ ] One driver boarding: scan QR at the origin stop.
- [ ] One parcel shipment: create with quote → accept → assign → load scan →
  in transit → arrival → ready → pickup code → collection.
- [ ] Public tracking for that parcel shows only safe fields.
- [ ] One incident: driver reports breakdown → Ops approves the recovery
  workflow (or assigns manually) → replacement assigned → passengers/parcel
  notifications queued.
- [ ] One withdrawal request from the driver; approve only after confirming
  FedaPay Payouts works in sandbox for the account.

## 7. Observability during the pilot

- [ ] Ops console → Diagnostics: check failed payments, anomalies, workflow
  failures, stale vehicle tracking, uncollected parcels.
- [ ] Run `pnpm smoke:prod` — must complete all checks without failing.
- [ ] Runbook in hand for each incident class (see `RUNBOOKS.md`).
