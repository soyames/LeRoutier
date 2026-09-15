# Production identity and provisioning

LeRoutier keeps one shared API and PostgreSQL domain. Identity proof comes from
an OIDC provider; authorization comes from the database on every request.
No provider has been selected or configured by this change. Missing settings
disable production sign-in and authenticated API operations fail closed.
Demo login remains forbidden on Vercel and whenever NODE_ENV is production.

## Provider setup

Register a **public browser client**, Authorization Code with mandatory PKCE S256,
without a client secret. The provider must issue RS256 or ES256 **JWT access
tokens** for the API audience; opaque access tokens are not supported. ID tokens
are consumed by the OIDC client, never used as API credentials. Enable token
endpoint CORS for the exact frontend origins. Use a distinct API audience from
the browser client ID. Configure the provider to issue short-lived access tokens.

Set these names on the **API project**, separately for Preview and Production:

| Variable | Required value |
| --- | --- |
| AUTH_ISSUER | Exact HTTPS issuer, including any trailing slash |
| AUTH_JWKS_URL | Provider's HTTPS public signing-key endpoint |
| AUTH_AUDIENCE | API resource identifier accepted in access-token aud |
| OIDC_CLIENT_ID | Public browser application's registered client ID |
| OIDC_SCOPE | Provider-supported scopes, including openid; default openid profile |
| OIDC_RESOURCE | Optional standards-based resource parameter, when required by provider |
| OIDC_REDIRECT_URIS | Comma-separated exact HTTPS app origins plus /auth/callback |

Register each callback with the provider. Register each app origin plus `/` as
an allowed post-logout URL. Configure all three frontend origins in the existing
CORS_ORIGINS. Preview URLs need explicit registration; no wildcard callback
policy is introduced. Local OIDC testing can use locally trusted HTTPS origins;
the browser tests use an intercepted provider with ephemeral test-only keys.
No invented provider endpoints belong in a deployment.

Keep DATABASE_URL and CORS_ORIGINS on the API project and VITE_API_URL on the three
frontend projects. No identity or database secret belongs in frontend env files
or VITE variables. `/auth/config` exposes only the public OIDC configuration.
Current Vercel Root Directories and SPA rewrites are unchanged; `/auth/callback`
is handled by the common provider before application routing starts.

The browser uses oidc-client-ts for state correlation, code exchange and PKCE.
Temporary state is held in sessionStorage and removed after the callback. Tokens
remain in memory; a page reload requires sign-in again (the provider may reuse
its SSO session). No silent refresh or persistent refresh token is enabled.
Expiry clears the local session. Sign-out always clears local identity and cached
API data, and uses the provider's end-session endpoint when available, without
putting token hints in URLs. Providers requiring an ID-token logout hint may keep
their SSO session; the local LeRoutier session is still closed.

## Mapping and authorization

The API verifies signature, algorithm, issuer, audience, expiry, required exp/iat/
sub claims and nbf when present. A verified subject maps to users.auth_subject;
users.auth_issuer pins it to the configured issuer. Repeated and concurrent first
login creates one Passenger user and passenger_profile. Display name and phone
come from explicit profile completion; JWT role/operator claims are ignored.
An existing identity without a matching issuer is rejected, never silently linked.
If migrating existing non-demo accounts, a database administrator must first
verify their issuer/subject mappings; this release does not guess them.

PATCH /me accepts only displayName and phone. An incomplete Passenger profile
cannot create a booking. Disabled users, inactive drivers and users of inactive
operators cannot authenticate. Driver and Ops identities keep their single
existing DB role; Passenger onboarding cannot assign privileged roles.

Operator-scoped Ops may provision staff and transport data only for their own
operator. Platform Ops (existing role=ops with operator_id=NULL) can create
operators and provision their staff. Public APIs cannot grant platform Ops.
Cross-operator role changes and self-modification through privileged provisioning
are rejected. New Ops accounts created through the API are always operator scoped.
The geographic place/stop catalog is shared; Ops can add entries, but there is no
global edit/delete endpoint. Services and staff remain operator scoped.

## First production operator

Run migrations before deploying the new API. `pnpm db:migrate` and
`pnpm db:validate` load the existing ignored root .env.local. To select a different
reviewed environment file, invoke the same scripts with Node's --env-file option.
Never paste credentials into a command, terminal output or documentation.

Obtain the initial person's **verified subject** from the chosen provider. In an
ignored local environment file set the BOOTSTRAP_* names listed in .env.example,
alongside the intended DATABASE_URL, DATABASE_SCHEMA and AUTH_ISSUER. Set
BOOTSTRAP_CONFIRM to `provision-first-operator` after reviewing the target.
Run `pnpm db:bootstrap`. It logs success/failure only, without identifiers.

By default this creates one operator and one operator-scoped Ops user. Set
BOOTSTRAP_PLATFORM_OPS=true only if the initial administrator must create further
operators. Optional BOOTSTRAP_DRIVER_SUBJECT, BOOTSTRAP_DRIVER_NAME and
BOOTSTRAP_DRIVER_LICENSE create the first driver for that operator atomically.
This provisions application authorization, not a password or provider account.
Create/invite identities at the provider first, or provision the verified identity
after its first safe Passenger login. No provider administration SDK is required.

A transaction and advisory lock protect a singleton bootstrap receipt. Repeating
identical inputs verifies success without duplicates; different inputs fail.
Bootstrap refuses to run if real Ops users already exist. There is no public
bootstrap endpoint. Remove bootstrap-only values from the local env after use;
keep the external credential source outside the repository. No production users
or transport data are automatically seeded.

## Ops provisioning API and UI

All mutations below require a verified active Ops user and Idempotency-Key.
Reusing a key with different input returns a conflict. Fields are allowlisted.

| Method/path | Payload / purpose |
| --- | --- |
| GET /auth/config | Public login configuration |
| GET /me | Verified DB identity, profile and needs_profile |
| PATCH /me | displayName, phone; own profile only |
| GET /ops/provisioning | Operator-scoped staff/vehicles/routes and shared places/stops |
| POST /ops/operators | name, key; platform Ops only |
| POST /ops/ops-users | subject, displayName, operatorId |
| POST /ops/drivers | subject, displayName, operatorId, licenseReference |
| PATCH /ops/users/:id/status | active boolean; explicit activation/deactivation |
| POST /ops/places | name, kind, optional parentId |
| POST /ops/stops | name, placeId, latitude, longitude |
| POST /ops/vehicles | operatorId, registration, capacity |
| POST /ops/routes | operatorId, name, stops: ordered [{stopId, fareToNext}] |
| POST /ops/services | routeId, vehicleId, driverId, departureAt (ISO timestamp) |

Use the existing Ops screen's Administration du réseau section in this order:
operator (platform Ops), staff, vehicle, localities/stops, ordered route and fares,
then departure with driver/vehicle assignment. The terminal stop's fare is zero;
other fares are nonnegative XOF minor units. Service creation snapshots the route,
fares and seats in one transaction and applies the existing assignment and
segment-capacity constraints. A driver/vehicle with an open assignment cannot be
assigned twice; finish or cancel its existing service first. Assigned drivers
cannot be disabled until their assignment ends or they are replaced.

Migration 004 adds issuer/activation/profile state, operator provisioning keys,
idempotency receipts, the singleton bootstrap receipt and append-only audit_events.
Privileged creations, role assignments and activation changes write audit and
outbox records in the same transaction. Application code cannot update/delete
audit entries. The database owner remains responsible for access to administrative
credentials and audit retention; this is not an event-sourcing system.

## Validation

Run frozen install, lint, typecheck, build, test, test:database, test:live,
db:validate and secrets:check. Database tests use disposable schemas on the
configured Neon connection; they never seed production tables. Browser OIDC tests
intercept a test provider and sign with ephemeral keys; recording is disabled.
No external provider configuration is needed for these tests. A final real-provider
sign-in across the three deployed callback URLs remains an operator rollout check
once valid provider settings and initial identities are available.

References: [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html),
[oidc-client-ts](https://authts.github.io/oidc-client-ts/),
[jose JWT verification](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md).
