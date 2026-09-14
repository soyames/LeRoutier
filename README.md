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

## Core product rule

Capacity is computed per segment, not per whole route. A seat occupied from Cotonou to Bohicon may be sold again from Bohicon onward after the passenger has alighted. Web, driver, operations and USSD clients must never implement separate capacity rules.

See `docs/UI_IMPLEMENTATION.md` for the UI architecture and coherence corrections.
