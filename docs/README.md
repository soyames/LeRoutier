# LeRoutier documentation

Start here. Every document below is current; anything superseded has been
removed rather than left to mislead.

## Start with these

| Document | Read it when |
| --- | --- |
| [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) | you need the shape of the whole system |
| [`architecture/UNIFIED_PWA.md`](architecture/UNIFIED_PWA.md) | you are working on the app shell, routing or workspaces |
| [`domain/TRANSPORT_MODEL.md`](domain/TRANSPORT_MODEL.md) | you are touching stops, capacity, bookings or fares |
| [`operations/MASTER_PRODUCT_COMPLETION.md`](operations/MASTER_PRODUCT_COMPLETION.md) | you want to know what is done, in progress or blocked |

## Architecture

- [`ARCHITECTURE.md`](architecture/ARCHITECTURE.md) — services, packages, boundaries
- [`UNIFIED_PWA.md`](architecture/UNIFIED_PWA.md) — one app, role-aware workspaces, legacy migration
- [`API_VERSIONING.md`](architecture/API_VERSIONING.md) — why `/api/v1` and what a v2 would mean
- [`OPERATOR_AND_CREW_MODEL.md`](architecture/OPERATOR_AND_CREW_MODEL.md) — operators, memberships, drivers, convoyeurs
- [`ONBOARDING_AND_LOCATIONS.md`](architecture/ONBOARDING_AND_LOCATIONS.md) — becoming an operator, boarding points
- [`PARCEL_LOGISTICS.md`](architecture/PARCEL_LOGISTICS.md) — consignment, custody, pickup
- [`MAPS_ROUTING_AND_TRACKING.md`](architecture/MAPS_ROUTING_AND_TRACKING.md) — **canonical** for maps, road routing, GPS, progress and ETA
- [`NOTIFICATIONS.md`](architecture/NOTIFICATIONS.md) — the event-driven notification layer
- [`AGENTIC_WORKFLOWS.md`](architecture/AGENTIC_WORKFLOWS.md) — principals, scopes, typed actions, approvals, autonomy
- [`MODEL_PROVIDERS.md`](architecture/MODEL_PROVIDERS.md) — what a model may see, suggest and never do
- [`USSD.md`](architecture/USSD.md) — the feature-phone channel over the same domain

## Domain and product

- [`domain/TRANSPORT_MODEL.md`](domain/TRANSPORT_MODEL.md) — the model everything else obeys
- [`product/PRODUCT_VISION.md`](product/PRODUCT_VISION.md) — what LeRoutier is for
- [`product/CX_AND_USER_JOURNEYS.md`](product/CX_AND_USER_JOURNEYS.md) — the journey per identity
- [`product/UI_INFORMATION_ARCHITECTURE.md`](product/UI_INFORMATION_ARCHITECTURE.md) — navigation, status vocabulary, form and state conventions
- [`product/SCREEN_DATA_SOURCES.md`](product/SCREEN_DATA_SOURCES.md) — screen → endpoint → service → table
- [`product/FIRST_LAST_MILE.md`](product/FIRST_LAST_MILE.md) — getting to the bus, and the Gozem handoff
- [`product/DRIVER_EARNINGS.md`](product/DRIVER_EARNINGS.md) — who owns which money
- [`product/FARE_INTELLIGENCE.md`](product/FARE_INTELLIGENCE.md) — the 5% commission model, fare history and the deterministic recommendation engine
- [`UI_IMPLEMENTATION.md`](UI_IMPLEMENTATION.md) — design system implementation notes

## Operations

- [`operations/README.md`](operations/README.md) — operational overview
- [`operations/MASTER_PRODUCT_COMPLETION.md`](operations/MASTER_PRODUCT_COMPLETION.md) — the execution ledger
- [`operations/PRODUCTION_READINESS.md`](operations/PRODUCTION_READINESS.md) — the release checklist
- [`operations/DATABASE_ENVIRONMENTS.md`](operations/DATABASE_ENVIRONMENTS.md) — production, local Docker, tests, and the guards between them
- [`operations/RUNBOOKS.md`](operations/RUNBOOKS.md) — migrations, incidents, recovery
- [`operations/VERCEL.md`](operations/VERCEL.md) — projects, environment-variable ownership, deployment
- [`operations/PILOT_ROLLOUT.md`](operations/PILOT_ROLLOUT.md) — how the pilot starts
- [`operations/PILOT_TEST_PLAN.md`](operations/PILOT_TEST_PLAN.md) — what the pilot verifies
- [`operations/AUTH_PRODUCTION_SETUP.md`](operations/AUTH_PRODUCTION_SETUP.md) — Firebase Authentication and Google Sign-In
- [`operations/FIREBASE_FREE_TIER.md`](operations/FIREBASE_FREE_TIER.md) — what Firebase is used for, and why billing stays off
- [`operations/SLO_AND_MONITORING.md`](operations/SLO_AND_MONITORING.md) — objectives and what is watched
- [`operations/USSD_ARCEP_APPLICATION.md`](operations/USSD_ARCEP_APPLICATION.md) — the regulator pack for a USSD shortcode

## Security and privacy

- [Operational load, query profiling and restore drills](operations/OPERATIONAL_DRILLS.md)

- [`security/SECURITY_MODEL.md`](security/SECURITY_MODEL.md) — the controls committed to
- [`security/THREAT_MODEL.md`](security/THREAT_MODEL.md) — actors, assets, STRIDE, residual risk
- [`security/AUTHORIZATION_MATRIX.md`](security/AUTHORIZATION_MATRIX.md) — who may do what, and where it is enforced
- [`security/PRIVACY_AND_RETENTION.md`](security/PRIVACY_AND_RETENTION.md) — what is stored, why, and for how long
- [`../SECURITY.md`](../SECURITY.md) — reporting a vulnerability

## API

- [`api/README.md`](api/README.md) — endpoints and contracts
- [`production-auth.md`](production-auth.md) — identity mapping, first operator bootstrap, Ops provisioning

## Research

- [`research/README.md`](research/README.md) — sources behind product and geography decisions

## Conventions

- **One document per subject.** A second document on the same subject is the
  documentation equivalent of a parallel architecture. `MAPS_ROUTING_AND_TRACKING.md`
  is the single maps document; there is deliberately no `MAPS_AND_ROUTING.md`.
- **No aspirational tense.** A document describes what the code does. Intent
  belongs in the ledger, marked as intent.
- **Never a secret**, not even a redacted one. Names of variables, never values.
