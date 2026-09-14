# LeRoutier Architecture

## Monorepo

LeRoutier uses a monorepo to keep domain contracts synchronized across passenger, driver, operations and backend applications.

```text
apps/
├── passenger-web/
├── driver-web/
└── ops-web/
services/
├── api/
├── worker/
└── ussd/
packages/
├── domain/
├── database/
├── geo/
├── notifications/
├── ui/
└── config/
infra/
├── docker/
├── deployment/
└── monitoring/
docs/
scripts/
tests/
```

## Boundaries

### Applications
User-facing presentation and interaction. Applications must not independently reimplement fare, capacity or booking invariants.

### API
Authoritative application boundary. Authentication, authorization, validation and domain orchestration happen here.

### Domain package
Pure/shared domain concepts and deterministic rules: ordered stops, segments, capacity evaluation, booking states, incident/recovery concepts and common identifiers.

### Database package
Schema, migrations, seed tooling and database-specific adapters. PostgreSQL is the target relational database; Neon can host it without leaking Neon-specific assumptions into the domain layer.

### Worker
Asynchronous tasks such as notification dispatch, payment reconciliation, scheduled departure state transitions and derived ETA/location processing.

### USSD service
Provider-facing USSD sessions mapped to the same API/domain rules. USSD must not become a second independent booking engine.

## Data ownership

The backend is authoritative for booking, payment and operational state. Clients may cache data for resilience but cannot become authoritative replicas.

## Mapping

Geographic data and transport-network data are separate. Map rendering is an adapter concern. OpenStreetMap data can be rendered through Leaflet in web clients, while routing/geocoding providers remain replaceable integrations.

## Real-time transport state

Vehicle location updates should be ingested through authenticated driver/device channels. The backend stores the latest accepted state and, where required, history. Passenger clients consume normalized vehicle/trip state rather than communicating directly with driver clients.

## Security principles

- least-privilege role/permission model;
- no secrets committed to Git;
- server-side validation for all financial and capacity-changing operations;
- idempotency for payment callbacks and booking mutations;
- immutable/auditable financial and operational event records where appropriate;
- explicit operator/platform tenancy boundaries;
- rate limiting and abuse protection at public entry points.

## Reliability principles

- transactional booking/capacity mutations;
- idempotent external callbacks;
- retry-safe background jobs;
- observable failures;
- graceful degradation for mapping/realtime features;
- offline/poor-connectivity UX that never falsely confirms an uncommitted booking/payment.

## Testing layers

1. domain unit tests;
2. database/integration tests;
3. API contract tests;
4. application component tests;
5. end-to-end passenger/driver/ops journeys;
6. concurrency tests for capacity and payment idempotency.
