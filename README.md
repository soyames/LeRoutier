# LeRoutier

Interurban mobility for Bénin: intercity trips, parcels and the operators who
run them — one platform, one shared transport domain.

**Product:** <https://le-routier.vercel.app> · **API:**
<https://le-routier-api.vercel.app/api/v1>

## One product, several workspaces

LeRoutier is **one** application. A person installs LeRoutier, signs in once,
and lands in whichever workspace their identity authorizes. Passenger,
Independent Owner-Driver, Company Driver, Convoyeur and Operations are use
cases *inside* LeRoutier — a user never meets our deployment architecture.

| Workspace | Route | Who |
| --- | --- | --- |
| Voyageur | `/` | everyone, most of it without an account |
| Conduite / Convoyeur | `/work` | crew attached to an operator |
| Exploitation | `/ops` | operations staff |

`apps/web` is that application. `apps/passenger-web`, `apps/driver-web` and
`apps/ops-web` are the **legacy** single-role apps: still deployed and still
tested so consolidation cannot silently regress, but no longer the product.
See [`docs/architecture/UNIFIED_PWA.md`](docs/architecture/UNIFIED_PWA.md).

## The rule that shapes everything

**Capacity is per segment, not per route.** A seat sold Cotonou → Bohicon is
sold again from Bohicon once that passenger alights. Every client — web, crew,
operations, USSD — goes through the same booking and capacity logic in
`packages/domain`. No client may implement its own.

## Layout

| Path | What lives there |
| --- | --- |
| `apps/web` | the unified PWA |
| `apps/{passenger,driver,ops}-web` | legacy single-role apps, kept for regression |
| `services/api` | the only thing that talks to the database (`/api/v1`) |
| `packages/domain` | booking, capacity, fares, state machines — pure logic |
| `packages/database` | schema, migrations, data access, safety guards |
| `packages/screens` · `packages/ui` | shared screens and design system |
| `packages/geo` · `packages/routing` | route geometry, progress, ETA, routing adapter |
| `packages/agents` | agent principals, typed action catalog, workflow engine |
| `packages/config` | server and client configuration, Firebase Authentication |

## Getting started

Node 24 and the pnpm pinned in `package.json` (`corepack enable` first).

```bash
pnpm install
```

### A database of your own

Development and tests run against a PostgreSQL container on your machine —
never against production. The image matches production's major version.

```bash
pnpm docker:up && pnpm db:local:migrate && pnpm db:local:seed
```

Then run the API and the unified PWA against it:

```bash
pnpm dev:local
```

`pnpm docker:reset` rebuilds it from empty. `pnpm docker:down` stops it.
`pnpm dev` runs every app including the legacy ones, against whatever
`.env.local` points at.

## Validation

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

| Command | What it proves |
| --- | --- |
| `pnpm test` | unit, API and browser suites |
| `pnpm test:database:local` | the domain against a real PostgreSQL |
| `pnpm test:migrate:fresh` | the migration chain still works from nothing |
| `pnpm test:live:local` | real API, real database, real browser, end to end |
| `pnpm secrets:check` | no credential in the tree, the diff, the history or a bundle |
| `pnpm smoke:prod` | production is actually serving |

Dependencies are installed once at the root; shared versions live in the
`pnpm-workspace.yaml` catalog and local packages use `workspace:*`. No
app-local installs, no `file:` dependencies.

## What the platform actually does

Real operators, real vehicles, real money — nothing is mocked into existence.

- **Booking** — segment-aware seats, online payment only for passengers, cash
  only through crew, tickets as QR plus a manual code.
- **Money** — FedaPay collections and payouts, an operator-owned ledger.
  Company employees cannot withdraw company money; an independent
  owner-driver can withdraw their own.
- **Parcels** — consignment, custody, scanning, pickup codes, and public
  tracking that reveals no party.
- **Maps and tracking** — real OpenStreetMap geography, real road geometry,
  real GPS. A straight line between two cities is never drawn as a road, and
  "live" is never claimed without a recent fix.
  See [`docs/architecture/MAPS_ROUTING_AND_TRACKING.md`](docs/architecture/MAPS_ROUTING_AND_TRACKING.md).
- **Identity** — Firebase Authentication with Google Sign-In. Google says who
  you are; the database says what you may do, and a token claim grants nothing.
  See [`docs/operations/AUTH_PRODUCTION_SETUP.md`](docs/operations/AUTH_PRODUCTION_SETUP.md).
- **Agentic operations** — domain events drive typed, scoped, audited agent
  actions. Money and privileged changes always wait for a human.
  See [`docs/architecture/AGENTIC_WORKFLOWS.md`](docs/architecture/AGENTIC_WORKFLOWS.md).

## Documentation

[`docs/README.md`](docs/README.md) is the index. Start there.

Security reports: [`SECURITY.md`](SECURITY.md) — privately, never a public issue.
