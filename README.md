# LeRoutier

LeRoutier is a transport platform designed around the real journeys of passengers, drivers and transport operators, starting with Benin.

The project is structured as a monorepo so passenger/driver experiences, operations, backend services, shared domain logic and infrastructure evolve together without duplicating core transport rules.

## Product surfaces

- **Passenger PWA** — search, trip discovery, booking, payment, trip tracking and alerts.
- **Driver PWA** — assigned trips, passenger/boarding operations, capacity, incidents and trip execution.
- **Operations/Admin** — network, stops, routes, vehicles, drivers, fares, incidents, payments and reporting.
- **API** — authoritative transport, booking, capacity, payment, location and operational business logic.
- **USSD integration** — accessibility path for users without a smartphone/data-heavy experience.

## Repository structure

```text
apps/
  passenger-web/       Passenger PWA
  driver-web/          Driver PWA
  ops-web/             Operations/admin web app
services/
  api/                  Core backend/API
  worker/               Background jobs and async processing
  ussd/                 USSD integration service
packages/
  domain/               Shared transport-domain types/rules
  database/             PostgreSQL/Neon schema and migrations
  ui/                   Shared UI primitives
  config/               Shared configuration
  geo/                  Mapping/geospatial abstractions
  notifications/        Notification/audio contracts
infra/
  docker/               Local container configuration
  deployment/           Deployment definitions
  monitoring/           Observability configuration
docs/
  product/              Vision, scope and user journeys
  architecture/         Technical decisions and diagrams
  domain/               Transport-domain documentation
  api/                  API contracts
  operations/           Operational procedures
  security/             Security/privacy documentation
  research/             Market/geographic research
scripts/                 Development/maintenance scripts
tests/
  e2e/                  Cross-application end-to-end tests
  fixtures/             Shared test fixtures
.github/
  workflows/            CI workflows
  ISSUE_TEMPLATE/       Issue templates
```

## Core principles

1. Model real transport journeys, including intermediate stops and segments—not only origin/destination pairs.
2. Capacity is segment-aware: a seat becoming free at an intermediate stop can be sold for the remaining journey.
3. Passenger and driver state must stay synchronized through one authoritative backend.
4. Support low-connectivity environments and progressive enhancement.
5. Geography, fares, operators and payment providers are configuration/data—not hard-coded UI assumptions.
6. Safety, incident handling and passenger recovery are first-class workflows.
7. Build auditable payment and operational records from the beginning.

## Initial technical direction

- Progressive Web Apps for passenger and driver experiences.
- PostgreSQL, with Neon as the intended managed database platform.
- OpenStreetMap-compatible mapping stack; Leaflet is suitable for web map rendering.
- API-first backend with explicit domain services.
- CI, automated tests and environment validation from the first implementation.

See `docs/product/PRODUCT_VISION.md`, `docs/architecture/ARCHITECTURE.md`, and `docs/domain/TRANSPORT_MODEL.md` before implementing product behavior.

## Status

Repository foundation initialized. Product implementation follows the documented domain model and architecture decisions.
