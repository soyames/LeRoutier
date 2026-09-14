# LeRoutier UI implementation

The Stitch exports supplied on 14 September 2026 are treated as a visual reference, not production HTML. The production UI is React-based and shares one design system through `packages/ui`.

## Coherence corrections

- Passenger screens contain passenger functions only: trip search, tickets, stations, live trip tracking and account.
- Driver screens contain operational route/boarding and driver profile/document functions.
- Regulation owns fleet telemetry, corridor capacity, contingencies and incident recovery.
- The original Stitch samples mixed some headings and navigation states (for example driver titles on passenger/regulation pages). These were normalized.
- Segment-aware capacity is explained consistently across passenger, driver and regulation views.
- Offline access is represented as a capability/fallback, not as a separate business flow.

## Technical baseline

- React 19 + Vite.
- pnpm monorepo.
- Vercel-ready SPA rewrites in each app.
- Shared design system in `packages/ui` using the LeRoutier orange/navy/green identity and Plus Jakarta Sans.
- Backend remains API-first and is expected to use Neon PostgreSQL. UI code does not duplicate booking/capacity rules; those rules belong in the API/database layer.

## Vercel projects

Create three Vercel projects from the same repository if deploying independently:

- `apps/passenger-web`
- `apps/driver-web`
- `apps/ops-web`

Each app's `vercel.json` defines the Vite framework, build and install commands,
`dist` output and SPA fallback. Keep source files outside the app Root Directory
included so the workspace and shared UI are available.

See [the deployment runbook](operations/VERCEL.md) for the complete settings and
validation commands. Installation uses the committed root lockfile in frozen mode.
