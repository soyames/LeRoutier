# Database environments

## Today

**Production, development and automated tests share one Neon database**,
separated only by `DATABASE_SCHEMA`:

| Schema | Environment | Contents |
| --- | --- | --- |
| `leroutier` | production | real pilot data. No demo rows, ever. |
| `leroutier_dev` | local development | demo seed (3 demo identities) |
| `lr_test_*` | automated tests | created and dropped per run |

**The connection string tells you nothing about which environment you are
touching — the schema is the environment.** This is the single most important
operational fact about this database.

### Confirming a target before writing

```bash
node --env-file=<reviewed env file> packages/database/scripts/status.js
```

Read-only. Prints the schema, the applied/pending migrations, absent tables and
whether demo identities are present. It never prints a host, a database name or
a credential — only a stable hash so two targets can be compared.

Independent cross-check: the live API. Before migrating, a route backed by a
missing table returns 503 while `/api/v1/routes` returns `200 []`; afterwards
the 503 becomes a proper 404.

## Guards

Sharing one instance is acceptable while there is no real pilot data, and
becomes unacceptable the moment there is. Until the split below happens, the
code enforces the separation (`packages/database/src/guards.js`):

- `assertDisposableSchema()` requires **all** of: a `*_dev` or `lr_test_*`
  schema, not the production schema, and a non-production runtime
  (`NODE_ENV`, `VERCEL`, `VERCEL_ENV`). A plausible schema name alone is not
  enough.
- `dropDisposableSchema()` will only ever drop `lr_test_*`. Every test teardown
  goes through it, so no suite can drop `leroutier` or `leroutier_dev` even by
  mistake — the guard lives in the helper, not at the call sites.
- `seed()` refuses any schema that is not disposable, so production cannot be
  seeded with demo data.
- The live suite prints its target (`schema=… environment=…`) before writing.

These guards are unit-tested (`packages/database/tests/guards.test.js`) and run
in `pnpm test:unit`, so they are verified even without a database.

## Leftover test schemas

An interrupted run leaves its `lr_test_*` schema behind — on the same instance
as production.

```bash
pnpm db:cleanup-tests                                        # dry run, lists candidates
CONFIRM_DROP_TEST_SCHEMAS=drop-test-schemas pnpm db:cleanup-tests
```

The script can only ever drop names beginning with `lr_test_`; `leroutier` and
`*_dev` are excluded by construction and re-checked immediately before each
drop. It is a dry run unless the confirmation variable is set exactly.

25 abandoned schemas were removed on 2026-09-16; production and development were
verified intact afterwards.

## Target state — separate Neon projects

Once real pilot data exists, production should not share an instance with
development and tests.

**Preferred:** two Neon projects (strongest isolation — separate credentials,
separate compute, no shared surface).

1. Create a `leroutier-dev` Neon project.
2. Point local `.env.local` at it with `DATABASE_SCHEMA=leroutier_dev`.
3. Run `pnpm db:migrate` then `pnpm db:seed` against it.
4. Run `pnpm test:database` and `pnpm test:live` to confirm.
5. Leave production untouched on the existing project, and remove the
   development and test schemas from it only after the new project is proven.
6. Update `DATABASE_ENVIRONMENTS.md` and the CI secret.

**Acceptable alternative:** a Neon *branch* for development. Cheaper and
instant, but branches share the project's credentials, so a leaked development
URL still reaches production compute. Prefer separate projects.

**Not done automatically.** This moves no data and destroys nothing: it creates
a new empty development database and re-seeds it. Production data is never
copied into a development environment — the pilot's real passengers, payments
and parcels stay where they are.

### Why it has not happened yet

It requires a Neon project to be created by the account owner and a new
`DATABASE_URL` to be placed in `.env.local` and CI. Both are outside what the
application can do for itself. The guards above are the interim control.

## Backup and restore

Neon provides point-in-time restore for the retention window on the project's
plan. For the pilot:

- **Before any migration**, confirm the restore window covers the change. Note
  the time; that is the rollback point.
- **Migrations are forward-only.** `migrate.js` runs in one transaction with an
  advisory lock and verifies checksums, so a failed migration leaves nothing
  half-applied. There is deliberately no automated `down` migration: rolling
  back schema changes against live pilot data is a decision, not a script.
- **To roll back**, restore the Neon branch to the noted time. Coordinate with
  the API deployment: a deployment expecting migration N against a database
  restored to N-1 will return 503 on the affected routes, which the smoke test
  detects.
- **Audit retention.** `audit_events` is append-only and is never pruned by the
  application. It is the record of who did what, and it survives restores
  within the retention window like any other table.

Export, if needed, is a standard `pg_dump` of the `leroutier` schema by the
account owner. The application performs no exports and holds no copies.
