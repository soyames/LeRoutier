# CX & User Journeys

Canonical product journeys per identity. All screens consume `/api/v1`
endpoints backed by the shared domain — see `SCREEN_DATA_SOURCES.md` for the
screen→endpoint→service→table trace.

## One product, several workspaces

LeRoutier is **one** application. A person installs LeRoutier, signs in once
with one identity, and lands in whichever workspace that identity authorizes.
Passenger, Independent Owner-Driver, Company Driver, Convoyeur and Ops are
**use cases inside LeRoutier**, not separate products — a user never needs to
know which deployment serves them.

| Workspace | Route prefix | Who |
| --- | --- | --- |
| Voyageur | `/` | everyone with an account |
| Mon activité / Conduite / Convoyeur | `/work` | `driver` or `convoyeur` |
| Exploitation | `/ops` | `ops` |

A workspace switcher appears only when an identity has more than one, and only
lists workspaces it is actually authorized for. Switching never creates a
second session. See `../architecture/UNIFIED_PWA.md` for the shell, routing and
migration plan; the three original apps remain deployed for regression until
the unified PWA has carried real pilot journeys.

The journeys below are unchanged by that consolidation — they describe the same
screens, now reached inside one app.

## Passenger

**Entry**: public landing = trip search (`/trips`) — no account required to
search or compare. Registration/login appears only when an action needs an
account (booking). First OIDC login creates the passenger identity safely;
profile completion (name/phone) is prompted before the first booking.

**Journey**: search origin→destination → compare real services (operator,
departure time, exact boarding/arrival point, price, seats, vehicle) →
"Se connecter pour réserver" → complete profile → booking hold → FedaPay
checkout (online only — cash is never offered) → trusted webhook
confirmation → ticket (QR + manual code + exact boarding point with map
link) → trip tracking.

**Key screens**: `/` (public home), `/trips`, `/tickets`, `/tickets/:bookingId`
(end-to-end journey), `/parcels`, `/tracking`, `/account`, `/notifications`,
`/onboarding` (operator entry).

**First and last mile**: the journey does not begin at the station. After a
booking exists, `/tickets/:bookingId` shows the exact boarding point, a
recommended leave-home time derived from the service schedule, and an
**optional** external handoff to a local provider (Gozem in Benin). LeRoutier
books no local ride and shows no provider fare or ETA; "J'y vais par mes
propres moyens" is always available, and the passenger's own location never
leaves their device. A delay recomputes the advice and supersedes the previous
recommendation rather than contradicting it. See `FIRST_LAST_MILE.md`.

**Notifications**: booking, payment, ticket, first-mile timing, boarding,
delay, boarding-point change, arrival and parcel updates arrive in the one
in-app notification centre. See `../architecture/NOTIFICATIONS.md`.

## Independent Owner-Driver

**Entry**: public `/onboarding` → explicit choice "Chauffeur indépendant".
One OIDC identity becomes operator owner + admin + driver in one
idempotent step (identity, licence, phone, optional vehicle). Status
`pending_verification` is shown everywhere until platform approval.

**Daily**: Today's service (exact boarding point), passenger manifest,
QR scanner, walk-up cash sale, parcels (load/depart/arrive scans, damage
reports), vehicle, boarding-point registry + proposals (clearly marked
"pending verification"), revenue & withdrawals (operator settlements).

**Mobile-first**: large actions, offline queue with sync status, no
desktop admin forms.

## Company Admin / Ops

**Entry**: public `/onboarding` → "Compagnie de transport" → company
profile → pending verification → platform verification → guided setup
checklist (station, vehicle, driver, convoyeur, route/fares, first
service) with progress, then the full Ops console.

**Ops console pages**: Today (diagnostics + approvals + verification
queue), Services, Fleet, Crew, Stations, Parcels, Payments, Settlements,
Incidents, Alerts, Settings (provisioning).

## Company Driver

Unique personal login; sees only crew functions: assigned service, route
with exact points, manifest, scanner, walk-up sales, parcels, vehicle,
incidents, GPS. Never revenue, withdrawals, fleet or operator settings.
Unprovisioned identities get an explicit explanation and the operator
contact step.

## Convoyeur

Separate journey in the same Driver/Crew console: navigation and labels
adapt (Service, Manifeste, Scanner, Comptant, Colis, Profil — no vehicle
page, no earnings). Priorities: ticket scan, walk-up cash, parcel
consignment/scan/custody, station reporting. Convoyeur is never Driver.

## Parcel Sender / Receiver

Sender (passenger app, authenticated): create shipment with quote → pay
online or at the operator counter (cash only via crew/Ops) → receipt QR →
track. Receiver: public tracking by `LRP-XXXXXXXX` — safe fields only
(status, cities, point names, vehicle-derived location), pickup code at
the operator station.

## Registration / onboarding states (rendered in UI)

unauthenticated → authenticated passenger → profile incomplete → operator
onboarding started → pending verification → verified | rejected |
suspended → staff provisioned | staff inactive. Each state shows its next
action.
