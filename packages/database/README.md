# Database Package

PostgreSQL/Neon-compatible schema, migrations, seed tooling and database adapters.

Key data areas: identity/roles, geography, stops/routes, operators, vehicles/drivers, scheduled services, segment capacity, bookings/manifests, fares, payments, tracking, incidents/recovery, notifications and audit records.

Concurrency tests are mandatory for booking capacity and payment idempotency.
