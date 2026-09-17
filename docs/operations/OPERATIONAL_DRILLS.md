# Load, query profiling and restore

Run pnpm test:operations after pnpm docker:up. The script refuses non-loopback
databases and production runtimes, creates a random disposable schema, seeds
synthetic users, operators, routes, services, bookings, a successful demo-only
payment, parcels, GPS and agent state, and cleans up its own targets.

It exercises trip search, availability, booking creation, ticket lookup, public
parcel tracking, GPS ingestion, notification duplicate bursts, Ops service list
and final-seat concurrency. It reports p50/p95/p99, unexpected error rate,
expected conflict/rate refusals, peak pool clients/waiters and ungranted locks
after each workload. These are local functional load baselines, not a Neon or
Vercel capacity certification. Post-workload lock sampling does not measure
every transient lock; pool waiters reveal queuing under contention.

EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) runs only SELECTs in the disposable
database for service search, segment availability, booking lookup, operator
services, parcel tracking, latest GPS, notifications and agent queue.
No speculative performance indexes were added. Uniqueness indexes added in
migration 015 enforce notification/workflow identity, not a guessed speedup.

## Actual restore procedure

The harness uses PostgreSQL 18 pg_dump -Fc inside the existing local container,
creates a separate lr_test_restore_* database, and runs pg_restore
--exit-on-error. It compares every table's count and SHA-256 digest of sorted
JSON rows before and after restoration. It then replays migrations and proves
the same row digests remain. Constraints and indexes are restored by pg_restore.
Only the generated local database and schema are removed.

Output: .tmp/operational-drill.json (metrics, query plans, complete restore
digests). A concise checked-in execution record appears in
[production readiness](PRODUCTION_READINESS.md). CI repeats the drill with
its PostgreSQL service container. No production snapshot or customer data is
downloaded by the drill.

## Production recovery runbook

1. Freeze writes and preserve incident evidence; identify the recovery point.
2. Confirm the actual Neon plan's restore history and a verified backup. Do not
   assume a paid retention window or enable a paid plan.
3. Restore into a separate approved database, never over production.
4. Verify migration checksums, users/operators/routes/services, occupation,
   payment uniqueness/currency, parcels/custody, GPS, agent receipts and audit.
5. Compare provider references before re-enabling payment/payout processing.
6. Review the concrete recovered database and switch the existing API's
   connection only with owner authorization. Keep the old target for rollback.

RPO assumption: time since the last verified recoverable snapshot; no numerical
production RPO is claimed without verifying the provider's current plan.
RTO target: 60 minutes for a small pilot after a usable snapshot and target are
available; the synthetic local drill measures only dump/restore/validation,
not incident response, provider availability or DNS. These are assumptions,
not guarantees.

## Road geometry without a paid service

The existing OSRM adapter stores full road coordinates, distance, duration and
per-stop legs in route_geometries. The coordinate fingerprint makes unchanged
routes reusable; changed stops cannot provide authoritative tracking geometry.
Provider failures preserve the text itinerary and never create straight lines.

A local, temporary OSRM v6.0.0 container was prepared with the
[Geofabrik Benin extract](https://download.geofabrik.de/africa/benin.html).
Use the [OSRM Docker preparation instructions](https://github.com/Project-OSRM/osrm-backend)
(extract with car.lua, partition, customize, routed --algorithm mld), bind the
router to loopback, and run pnpm test:routing:local. No new production service
or Vercel project is needed for batch route preparation.

For real existing routes, scripts/route-geometry.mjs first inspects the target.
With a reviewed environment, ROUTING_URL and the active Ops ROUTING_ACTOR_ID,
--write generates only that operator's existing routes into the canonical DB.
No stops/services/demo routes are created. A later route change requires another
batch or an entitled configured OSRM endpoint. Car-profile duration is a road
input, not a bus timetable or traffic prediction.

Production currently has no routes. Populating real routes belongs to operator
onboarding; the local synthetic corridor is never inserted into production.
