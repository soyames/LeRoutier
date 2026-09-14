# Contributing to LeRoutier

## Before coding

Read the product vision, architecture and transport-domain model. Do not introduce a second source of truth for booking, capacity, fares or payments.

## Workflow

1. Create a focused branch.
2. Keep domain/business logic out of presentation components.
3. Add or update tests with behavior changes.
4. Document architecture/domain decisions that alter established invariants.
5. Never commit credentials or production personal data.
6. Run lint, typecheck, tests and build before merge.

## Changes requiring special care

- segment-capacity calculations;
- concurrent booking behavior;
- fare calculations;
- payment callbacks/reconciliation;
- permissions/tenancy;
- location/privacy handling;
- incidents and passenger recovery.
