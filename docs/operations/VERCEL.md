# Vercel deployment

The **unified LeRoutier PWA (`apps/web`) is the canonical frontend.** The three
original apps stay deployed for regression until it has carried real pilot
journeys — see `../architecture/UNIFIED_PWA.md` for the migration plan.

| Application | Vercel project | Root Directory | Local port |
| --- | --- | --- | --- |
| **LeRoutier (unified)** | `le-routier` | `apps/web` | 3003 |
| Passenger (legacy) | `le-routier-passenger` | `apps/passenger-web` | 3000 |
| Driver (legacy) | `le-routier-driver` | `apps/driver-web` | 3001 |
| Regulation (legacy) | `le-routier-ops` | `apps/ops-web` | 3002 |

## CORS

The API must allow every deployed frontend origin. `CORS_ORIGINS` on
`le-routier-api` therefore needs the unified origin **added**, with the
existing three kept until the old apps are retired:

```
https://le-routier.vercel.app,https://le-routier-passenger.vercel.app,https://le-routier-driver.vercel.app,https://le-routier-ops.vercel.app
```

A future custom domain is appended the same way. Exact origins only — no
wildcards. The API admits requests that carry no `Origin` header, which is what
a same-origin call through the unified app's `/api/v1` rewrite sends.

Select Node.js 22.x and enable **Include source files outside of the Root
Directory in the Build Step** in each project's Root Directory settings.
This dashboard setting is required for access to the root workspace/lockfile
and `packages/ui`; it cannot be set in `vercel.json`.
See [Vercel's monorepo FAQ](https://vercel.com/docs/monorepos/monorepo-faq).

Each app's committed `vercel.json` provides:

- Framework: `vite`.
- Install: `corepack pnpm --dir ../.. install --frozen-lockfile`.
- Build: `corepack pnpm run build` (runs in the app directory).
- Output: `dist`.
- SPA rewrite: `/(.*)` to `/index.html`.

Corepack reads the pnpm version from the root `packageManager` field. The install
command installs the complete workspace, including the shared package's own
dependencies. Do not override it with npm or an app-only install. No production
credentials are needed to build these static frontends.

## Why the previous deployment failed

There was no committed lockfile. Vercel defaults to npm without a lockfile;
npm does not implement pnpm's `workspace:*` protocol. Replacing that protocol
with `file:../../packages/ui` allowed an app-local npm install to succeed, but
left the linked UI source without its own installed dependency tree. A clean
Passenger install reproduced:

```text
[vite]: Rollup failed to resolve import "lucide-react" from ".../packages/ui/src/shell.jsx"
```

The fix is one root pnpm installation and lockfile, `workspace:*` links, and a
shared version catalog. `packages/ui` exports its source JSX and CSS directly;
Vite compiles that source in each app's build. React remains a peer dependency
of UI, with local development dependencies for checking the package, and Vite
deduplicates React/React DOM. No UI copy, alias, prebuild or Rollup external is
needed. See [Vercel package-manager detection](https://vercel.com/docs/package-managers).

## Verify before deployment

From a fresh checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm exec playwright install chromium
pnpm test
```

To reproduce the app Root Directory build locally, run these commands inside
each of the three app directories:

```bash
corepack pnpm --dir ../.. install --frozen-lockfile
corepack pnpm run build
```

CI runs each app's actual `vercel.json` commands in a separate clean Linux job,
as well as root validation and browser tests of production output. To use the
Vercel CLI with a real project, link the appropriate project and pull its
settings before running `vercel build --prod` from the repository root. Local
builds alone do not verify the dashboard setting or a deployed URL.

Validation on 2026-09-14 used Node 24.19.0, pnpm 10.34.5 and Vercel CLI 59.17.0:
root clean installation, frozen installation, lint, JavaScript type checking,
all three production builds, ten desktop/mobile browser tests and dependency
audit passed. Each app also passed a fresh isolated installation from its app
directory, `pnpm build`, and `vercel build --prod`. Those CLI runs used local
settings with the respective app Root Directory; no remote project was linked
or deployed. Generated Vercel assets and filesystem-before-SPA routing were
checked, and every clean installation preserved the lockfile. Linux/Node 22
validation is configured in CI; it was not run in this Windows session.

## SPA paths

Passenger supports `/`, `/trips`, `/tickets`, `/stations`, `/tracking` and
`/account`. Driver supports `/`, `/route` and `/profile`. Navigation updates the
URL and supports refresh and browser Back/Forward. Unknown Passenger/Driver
paths return to the default screen. Regulation currently has one dashboard;
its fallback displays that dashboard for direct paths.

Vite emits asset URLs under `/assets/`. Vercel serves existing static files
before applying the SPA fallback. After deployment, open and refresh a deep
link such as `/tickets` or `/profile`, and check that JavaScript/CSS requests
return assets. See [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite).

## Backend, Neon and production identity

The shared API and PostgreSQL transport domain are implemented in services/api
and packages/database. Preserve the API project's existing Root Directory and
deployment settings. DATABASE_URL and CORS_ORIGINS belong on the API project;
VITE_API_URL belongs on each frontend. Production contains no automatic demo seed.
Static frontend builds do not need database credentials.

See [production identity and provisioning](../production-auth.md) for OIDC
configuration, migration order, first-operator bootstrap and Ops workflows.
All three apps support /auth/callback through the existing SPA fallback. Provider
settings must be real registered values; incomplete configuration fails closed.

## Environment-variable ownership

**One public product does not mean one security boundary.** A variable exists
only where it is needed, and the PWA needs almost nothing.

The unified PWA is a static Vite build with no serverless functions. Vite
inlines only `VITE_`-prefixed variables, and everything else in a frontend
project is read by nothing. Placing a server secret there would add exposure
for zero function.

| Project | Variables | Why |
| --- | --- | --- |
| `le-routier` (PWA) | `VITE_API_URL` | the only variable any frontend code reads; `same-origin` because `/api/v1/*` is rewritten to the API |
| `le-routier-api` | `DATABASE_URL`, `CORS_ORIGINS`, `PAYMENT_PROVIDER`, `FEDAPAY_*`, `PAYOUT_APPROVAL_REQUIRED`, `AGENT_MODEL_PROVIDER`, `OPENROUTER_*`, `AUTH_*`, `OIDC_*`, `NOTIFICATION_*` | the only project that runs server code |
| legacy frontends | `VITE_API_URL` (+ 15 unused variables) | see below |

Names only. Values appear in this repository nowhere, ever.

### Sensitive is not the same as encrypted

Vercel's **Sensitive** variables are write-only: their values cannot be read
back by the CLI, the REST API, or the dashboard. That is the right storage for
anything that grants access.

| Variable | Type today | Should be |
| --- | --- | --- |
| `DATABASE_URL`, `FEDAPAY_*` | Sensitive | ✔ |
| **`OPENROUTER_API_KEY`** | **Config** | **Sensitive, Production-only** |

`OPENROUTER_API_KEY` is currently stored as an ordinary Config variable and is
exposed to **Preview** as well as Production. Preview deployments have publicly
reachable URLs, so that widens where the key can be used. It grants spend
against a quota rather than access to passenger data, which is why this is a
hardening item rather than an incident — but it should match the others.

Fixing it requires the value, which only the owner should handle:

```bash
vercel env rm OPENROUTER_API_KEY --yes
vercel env add OPENROUTER_API_KEY production --sensitive
```

This was deliberately **not** done automatically: re-adding needs the secret,
and a failed re-add would leave production without a key.

### The legacy frontends carry 15 dead variables

`le-routier-passenger`, `le-routier-driver` and `le-routier-ops` each hold
`NODE_ENV`, `PASSENGER_APP_URL`, `DRIVER_APP_URL`, `OPS_APP_URL`, `API_URL`,
`MAP_TILE_URL`, `GEOCODING_API_URL`, `ROUTING_API_URL`, `PAYMENT_PROVIDER`,
`PAYMENT_API_KEY`, `PAYMENT_WEBHOOK_SECRET`, `USSD_PROVIDER`, `USSD_API_KEY`,
`NOTIFICATION_PROVIDER` and `NOTIFICATION_API_KEY`.

Thirteen of those fifteen are read by **zero** source files. Several no longer
exist under those names anywhere in the codebase — `PAYMENT_API_KEY` and
`PAYMENT_WEBHOOK_SECRET` were superseded by `FEDAPAY_SECRET_KEY` and
`FEDAPAY_WEBHOOK_SECRET`. They are scaffold residue.

They are also all **Sensitive**, so they cannot be read back and therefore
cannot be migrated anywhere — which is moot, because nothing would read them.
They should be deleted with the legacy projects.
