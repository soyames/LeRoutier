# LeRoutier

LeRoutier is a Bénin-focused interurban mobility platform built around one shared transport domain: ordered stops, segment-aware seat capacity, reservations, boarding, live operations and offline fallbacks.

## Frontend applications

- `apps/passenger-web` — passenger PWA-style React interface: search, segment-aware availability, tickets, stations, trip tracking and account.
- `apps/driver-web` — driver/chef de bord interface: active route, passenger manifest, boarding scanner, offline validation, incidents and driver documents.
- `apps/ops-web` — regulation interface: fleet telemetry, corridor capacity, station load, incident handling and recovery.

All three applications use the shared LeRoutier design system from `packages/ui`, based on the supplied Stitch interfaces and LeRoutier brand identity.

## Technical stack

- React.js 19 + Vite
- pnpm workspaces
- Vercel deployment
- Neon PostgreSQL for the shared backend database
- API-first architecture: PWA, driver tools, operations and USSD must call the same booking/capacity logic

## Local development

Use Node.js 22.13+ (Node 22 LTS in CI) and the pnpm version pinned in
`package.json`. Enable the pnpm command with `corepack enable` first.

```bash
pnpm install
pnpm --filter @leroutier/passenger-web dev
pnpm --filter @leroutier/driver-web dev
pnpm --filter @leroutier/ops-web dev
```

To build everything:

```bash
pnpm build
```

The apps run on ports 3000 (Passenger), 3001 (Driver) and 3002 (Regulation).
Build an individual app with `pnpm --filter @leroutier/passenger-web build`
(or the corresponding Driver/Ops name), or run `pnpm build` inside its directory.

Dependencies are installed once at the repository root. Keep `pnpm-lock.yaml`
committed and use `pnpm install --frozen-lockfile` in CI. Shared dependency versions
live in the `pnpm-workspace.yaml` catalog; local packages use `workspace:*`.
Do not use app-local npm installs or replace workspace dependencies with `file:`.

Validation:

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm exec playwright install chromium
pnpm test
```

The browser tests serve the production bundles and exercise direct URLs, reloads,
navigation/history and the shared UI on desktop and mobile. See
[Vercel deployment](docs/operations/VERCEL.md) for app Root Directory settings,
SPA routing and backend environment boundaries.

## Core product rule

Capacity is computed per segment, not per whole route. A seat occupied from Cotonou to Bohicon may be sold again from Bohicon onward after the passenger has alighted. Web, driver, operations and USSD clients must never implement separate capacity rules.

See `docs/UI_IMPLEMENTATION.md` for the UI architecture and coherence corrections.
