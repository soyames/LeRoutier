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
2. Apply them against the production database (use the same connection
   string as Vercel's `DATABASE_URL`; the value is never shared):

   PowerShell: `$env:DATABASE_URL="<production value>"; node --env-file=.env.local packages/database/scripts/migrate.js`

   Git Bash: `DATABASE_URL="<production value>" node --env-file=.env.local packages/database/scripts/migrate.js`

3. The runner reports "Migrations validated: N" and is replay-safe: reruns
   are no-ops. Then re-run `pnpm smoke:prod`. **Verify the target first**:
   the local `.env.local` database is the development Neon (it contains demo
   data) — always copy the connection string from Vercel's `DATABASE_URL`
   itself, never assume the local value is production. Current migrations:
   001–008.
4. New deployments must come from git pushes (`main`). Manual dashboard
   deploys of the API project can ship stale source.

## Auth outage (OIDC unavailable)

1. Confirm `GET /api/v1/auth/config` still serves (it always returns public
   configuration). Check the provider status page.
2. Sign-in fails closed: existing API sessions keep working until expiry;
   no new sessions.
3. Demo login is disabled in production and must not be enabled as a
   workaround. If the outage exceeds the provider SLA, follow the provider
   incident channel; no LeRoutier action fabricates identities.
