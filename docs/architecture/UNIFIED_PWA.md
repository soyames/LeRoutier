# The unified LeRoutier PWA

LeRoutier is one product. A person installs **LeRoutier**, signs in once, and
lands in whichever workspace their identity authorizes. Passenger, Driver,
Convoyeur and Ops are use cases inside the app, not separate products.

```
one PWA (apps/web)
  -> public experience          anonymous search, tracking, onboarding entry
  -> authentication             one OIDC identity, PKCE
  -> role/operator-aware workspace
  -> same /api/v1 backend       (services/api, unchanged)
  -> same Neon database
```

## Canonical app

| | |
| --- | --- |
| Path | `apps/web` (`@leroutier/web`) |
| Vercel project | `le-routier` |
| Shared screens | `packages/screens` |
| API | `services/api` — **not** merged, not forked, not duplicated |

The three original apps (`apps/passenger-web`, `apps/driver-web`,
`apps/ops-web`) still build and deploy. They are kept deliberately for
regression comparison until the unified app has carried every journey in
production, and they now consume the **same** screen modules — there is one
source of truth, not a copy.

### Why `packages/screens`

Consolidating the frontend must not fork the UI. The passenger, crew and ops
screens moved (with history) into `packages/screens`:

| Module | Was |
| --- | --- |
| `@leroutier/screens/passenger` | `apps/passenger-web/src/screens.jsx` |
| `@leroutier/screens/crew` | `apps/driver-web/src/screens.jsx` |
| `@leroutier/screens/ops` | `apps/ops-web/src/screens.jsx` (+ provisioning) |
| `@leroutier/screens/journey` | new — first/last mile and journey timeline |
| `@leroutier/screens/notifications` | new — notification centre and preferences |

Both the unified app and the legacy apps import from there. A fix lands once.

## Identity and workspace resolution

`GET /api/v1/me` is authoritative. The client resolves workspaces from the
identity it returns — role, operator, operator type, ownership, verification
state — never from a frontend flag (`apps/web/src/workspaces.js`).

| Workspace | Shown when | Route prefix |
| --- | --- | --- |
| Voyageur | always (anyone with an account can travel) | `/` |
| Mon activité / Conduite / Convoyeur | role is `driver` or `convoyeur` | `/work` |
| Exploitation | role is `ops` | `/ops` |

The work workspace adapts further:

- **Independent owner-driver** (`operator_type = independent` and the operator's
  owner) additionally sees boarding points, revenue and withdrawals.
- **Company driver** sees the assigned service, manifest, scanner, walk-up,
  parcels and vehicle — and **never** settlements, withdrawals, fleet
  management or company settings.
- **Convoyeur** gets crew wording and no driver-only vehicle tools.

There is no second session per workspace: switching is navigation within one
authenticated identity.

### The current identity model

`users.role` holds one role today. This phase did **not** introduce a
multi-role identity model, so "one identity, several workspaces" means exactly
what the database supports: every identity gets the passenger workspace plus
whichever operational workspace its role grants. When a true multi-role model
is introduced, `workspacesFor()` is the single place that changes.

## Routes

```
/                      public home
/trips                 anonymous search
/tickets               own bookings
/tickets/:bookingId    booking + end-to-end journey timeline (first/last mile)
/parcels  /tracking  /stations  /account  /onboarding  /notifications

/work/today  /work/manifest  /work/scanner  /work/walk-up  /work/parcels
/work/vehicle  /work/boarding-points  /work/earnings  /work/profile  /work/notifications

/ops/today  /ops/services  /ops/fleet  /ops/crew  /ops/stations  /ops/parcels
/ops/payments  /ops/settlements  /ops/incidents  /ops/alerts  /ops/settings  /ops/notifications
```

Only routes backed by a real screen exist. No placeholder route was added to
match a suggested structure.

### Deep links

Every route survives a refresh through the SPA rewrite. `/tickets/:bookingId`
uses its id to render that booking's journey timeline. An unauthorized
workspace shows an explicit "not authorized" state — it never silently
redirects an authorized user to an unrelated home screen.

## Authorization

Route guards are UX only. Every protected action is authorized server-side on
each `/api/v1` call, scoped by identity and operator. Typing `/ops` or
`/work/earnings` renders a shell whose data calls are refused by the API; it
grants nothing. Cross-operator access remains rejected by the API.

## Login

Authentication is LeRoutier's, not a per-app login: one OIDC public client with
PKCE, no local passwords. After sign-in the app resolves available workspaces
and stays on the route the user asked for.

## PWA

One installable app named **LeRoutier** — not "LeRoutier Passenger" or
"LeRoutier Driver". `start_url` and `scope` are `/`, so an install covers every
workspace. Icons (192, 512, maskable 512, apple-touch) are generated from the
brand mark and committed under `apps/web/public`.

Offline behaviour is unchanged for crew: the app shell and static assets are
precached, authenticated API responses are never cached, and the existing
localStorage offline action queue (scans, parcel custody, idempotency keys,
retry and conflict handling) is reused as-is from `@leroutier/config/offline`.

## API relationship

The unified app calls `/api/v1` on the existing API project through
`VITE_API_URL`. The backend was not merged into the frontend and no handler was
duplicated.

### Same-origin proxy

`apps/web/vercel.json` rewrites `/api/v1/:path*` to the API project **before**
the SPA fallback, so `https://<unified-domain>/api/v1/...` already resolves.
This is safe with the current design: the API authorizes with Bearer tokens
rather than cookies, and its CORS check admits requests that carry no `Origin`
header, which is what a same-origin call sends.

Status: **prepared and deployed, not yet used.** The app still calls the API
directly via `VITE_API_URL`, because the session client treats an empty base
URL as "API not configured" — a guard that stops an unconfigured build from
shipping. Switching to same-origin is a deliberate follow-up, not an accident.

## Future custom domain

Attaching `https://leroutier.bj` requires no code change:

1. attach the domain to the `le-routier` Vercel project;
2. add `https://leroutier.bj/auth/callback` to `OIDC_REDIRECT_URIS`, and to the
   provider's registered redirect URIs;
3. add `https://leroutier.bj` to the API's `CORS_ORIGINS`;
4. set `VITE_API_URL` (or switch to the same-origin proxy above).

Existing origins stay in `CORS_ORIGINS` until the old apps are retired.

### OIDC redirect URIs

| Now | Future |
| --- | --- |
| `https://le-routier.vercel.app/auth/callback` | `https://leroutier.bj/auth/callback` |
| `https://le-routier-passenger.vercel.app/auth/callback` | retired with the old app |
| `https://le-routier-driver.vercel.app/auth/callback` | retired with the old app |
| `https://le-routier-ops.vercel.app/auth/callback` | retired with the old app |

No provider credentials are invented here; these are the URLs to register once
a provider exists.

## Data integrity

No static operational mock data. Every service, vehicle, crew member, parcel,
payment and location comes from `/api/v1`. An empty production database renders
honest empty states, which the browser suite asserts.

## Old-app migration plan

1. Unified app deployed alongside the three apps (now).
2. Regression: both suites run in CI; the old apps keep their journeys.
3. Once the unified app has carried real pilot journeys, mark it canonical and
   add redirects from the old app URLs to the matching unified routes.
4. Retire the old projects, then drop their origins and redirect URIs.

Nothing is deleted before that.
