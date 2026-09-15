# Runbooks

Concise operational procedures. Start from the Ops console Diagnostics section
(`/api/v1/ops/diagnostics`) unless a runbook says otherwise. Never fabricate a
provider success event: every state below moves only through trusted
reconciliation or an Ops-privileged, audited action.

## Failed payment (passenger FedaPay collection)

1. Ops console → "Paiements en ligne" → filter by status.
2. If `pending`: the passenger may still be on the FedaPay page — do not
   record anything; the webhook will resolve it.
3. If `failed`: press "Réconcilier" — the server fetches the trusted FedaPay
   transaction state and applies it. Repeated reconciliations are idempotent.
4. If the booking hold expired or the service departed while `pending`:
   reconciliation lands in review; refunds/credits follow product policy,
   never a fabricated success.
5. Every reconciliation is audited (`payment.*` events).

## Failed payout (driver withdrawal)

1. Ops console → "Versements conducteurs" → status "Échoué".
2. If `PAYOUT_UNAVAILABLE` / provider refusal: confirm FedaPay Payouts is
   activated for the account and `FEDAPAY_PAYOUT_SECRET_KEY` is set; then
   press "Relancer le versement" (re-reserves the balance and re-executes).
3. If `processing` for more than a few minutes: press "Vérifier auprès du
   prestataire" — the server fetches the payout status; only a trusted
   provider result can mark it paid or release the reservation.
4. Never mark a payout paid by hand.

## Invalid FedaPay webhook

1. Invalid signatures return 401 and FedaPay retries with fresh
   signatures — usually a configuration mismatch: confirm the webhook
   endpoint secret in FedaPay Workbench matches `FEDAPAY_WEBHOOK_SECRET`
   (per-endpoint, distinct sandbox/live).
2. Signature-valid but mismatched events are answered 200 and stored as
   `payment.anomaly` / `payout.anomaly` outbox events → Diagnostics →
   "Anomalies paiement". Review via the payments/payouts lists; reconcile
   manually only after checking the FedaPay dashboard.

## Service breakdown

1. Driver reports the incident (offline-capable; syncs on reconnection).
2. Ops console → Incidents: the agentic recovery workflow proposes a
   replacement (eligible vehicles, affected passengers). Approve with the
   chosen driver, or reject and handle manually.
3. Assignment closes the old one and notifies affected passengers
   (`notification.send` outbox). Parcels on the service follow the
   parcel-breakdown workflow with their own approval gate.
4. Audit: `service.recovery_assigned`.

## Lost / damaged parcel

1. The exception is recorded by driver/ops (`parcel.exception` event +
   alert). Parcel state moves to `damaged`/`lost` only through the validated
   transition.
2. If `damaged` → decide with the sender: return (`return_requested` →
   `returned`) or deliver.
3. If `lost`: terminal state; compensation follows product policy — no
   automatic movement.
4. Parcel exception stays open in Diagnostics until resolved by product
   decision; resolve it in the parcels exception view when closed.

## Uncollected parcel

1. Diagnostics → "Colis non retirés (24h+)".
2. Re-issue a pickup code (supersedes the previous one) and notify the
   receiver; escalation to a phone call follows product policy.
3. Agent action `parcel.uncollected` returns the full list for an
   automation to act on — approval rules still apply to mutations.

## Offline sync conflict

1. Driver console shows queued actions; conflicts (server-rejected) display
   an "Ignorer" option.
2. `conflict` means the action is no longer valid against current server
   truth (e.g. boarded after service advanced): check the manifest, discard
   the stale action, re-issue the correct one.
3. `failed` (network) actions retry automatically on reconnection; the
   server deduplicates by Idempotency-Key, so replays can never duplicate
   custody or boarding events.

## Data routes return 503 after a deploy (schema missing)

1. `GET /api/v1/health` still passes (it only probes connectivity) while data
   routes 503 — this usually means the production database is missing recent
   migrations. Migrations are **not** applied automatically on deploy.
2. Obtain the production connection string. `DATABASE_URL` is marked
   **Sensitive** on the Vercel project, so it is write-only: `vercel env pull`
   and the REST API return `[SENSITIVE]`, never the value. Copy it from the
   Vercel or Neon dashboard. Never guess it, and never assume the local value
   is production.
3. Put it in a reviewed, git-ignored file — `.env.production.local` — holding
   **only** these two names:

   ```
   DATABASE_URL=<production value>
   DATABASE_SCHEMA=leroutier
   ```

   Do **not** reuse `--env-file=.env.local` with a shell override. A shell
   variable does win over `--env-file`, but `.env.local` also sets
   `DATABASE_SCHEMA=leroutier_dev`; overriding only `DATABASE_URL` would apply
   the migrations to a `leroutier_dev` schema **on the production database**,
   leaving the API (which reads `leroutier`) still broken. Production sets no
   `DATABASE_SCHEMA`, so it uses the `leroutier` default.
4. Confirm the target before writing anything. `db:status` is read-only and
   prints no connection string, host or credential:

   `node --env-file=.env.production.local packages/database/scripts/status.js`

   Production must report `No demo identities` and list 005–008 as `Pending`.
   If it reports `Demo identities present`, it is the development database —
   stop.
5. Apply, then re-check:

   `node --env-file=.env.production.local packages/database/scripts/migrate.js`

   The runner reports "Migrations validated: N", takes an advisory lock, runs
   in one transaction, verifies checksums of applied files and is replay-safe:
   reruns are no-ops. Re-run the `status.js` command; it must report `8/8
   applied; 0 declared table(s) absent`. Then `pnpm smoke:prod` (10/10).
6. Delete `.env.production.local` when finished.
7. Current migrations: 001–008. Applying them creates empty tables only —
   production business data is created solely through the real onboarding and
   Ops flows, never by a seed.
8. New deployments must come from git pushes (`main`). Manual dashboard
   deploys of the API project can ship stale source.

## Auth outage (OIDC unavailable)

1. Confirm `GET /api/v1/auth/config` still serves (it always returns public
   configuration). Check the provider status page.
2. Sign-in fails closed: existing API sessions keep working until expiry;
   no new sessions.
3. Demo login is disabled in production and must not be enabled as a
   workaround. If the outage exceeds the provider SLA, follow the provider
   incident channel; no LeRoutier action fabricates identities.
