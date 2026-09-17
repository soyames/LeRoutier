# Database environments

| Environment | Database | Permitted routine use |
| --- | --- | --- |
| Production | Existing Neon PostgreSQL 18, schema leroutier | API runtime; reviewed migrations; read-only status |
| Development | Docker PostgreSQL 18 on loopback port 55432 | Schema leroutier_dev, synthetic fixtures |
| CI | PostgreSQL 18 service container on loopback port 55432 | Disposable lr_test_* schemas only |
| Restore drill | New local disposable database lr_test_restore_* | Restore synthetic dump, compare all rows, then drop |

createDatabase rejects every *_dev or lr_test_* schema on a non-loopback host.
Seed and schema-drop guards additionally reject production runtimes and the
production schema. A local .env.local that still names a Neon development schema
will now fail closed. Use docker/postgres.env for ordinary development and tests.

Commands: pnpm docker:up, pnpm db:local:migrate, pnpm db:local:seed,
pnpm test:database:local, pnpm test:migrate:fresh, pnpm test:operations.
Never use a production credential for these commands.

The deployed API initializes one cached handler/pool per warm process, with at
most five clients, a 15-second connection timeout, 10-second idle and lock
timeouts, and a 30-second statement timeout. Neon production uses its pooled
hostname (verified read-only). Pooling bounds each process, not the number of
Vercel instances. Monitor waiting clients and Neon connection limits; no claim
of unlimited capacity is justified by a five-client pool.

There is no paid staging database and none is required for these gates.
See [operational drills](OPERATIONAL_DRILLS.md) for profiling and restoration.
