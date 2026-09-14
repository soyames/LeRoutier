# Vercel deployment

Create one Vercel project per application, using the same Git repository:

| Application | Root Directory | Local port |
| --- | --- | --- |
| Passenger | `apps/passenger-web` | 3000 |
| Driver | `apps/driver-web` | 3001 |
| Regulation | `apps/ops-web` | 3002 |

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

## Backend and Neon

The API, worker, USSD, database and domain directories currently contain design
documentation, not executable services. Frontend screens use demonstration
data; this build repair does not turn them into live booking/payment tools.

Keep `DATABASE_URL` and payment/provider credentials in the future backend's
server environment. `.env.example` documents placeholders only. Never prefix
database credentials with `VITE_`: Vite exposes those variables to the browser.
When the API is implemented, expose only its public URL as `VITE_API_URL` in
each frontend project's environment and keep all capacity/payment mutations
server-authoritative. The current builds do not require an API or Neon connection.
