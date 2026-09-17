# Public API surface

Every `/api/v1` endpoint, classified by who may call it. The API hostname being
public is not itself a risk: the protections are authentication, role and
tenant checks on every handler, minimal public projections, rate limits and
fail-closed provider verification — none of which depend on the hostname being
secret.

Classes: **PUBLIC** (anonymous), **AUTHENTICATED** (any verified identity),
**ROLE_RESTRICTED** (role + operator boundary), **WEBHOOK** (cryptographically
verified provider callbacks), **AGENT** (service principals, separate token
namespace). Anything not listed 404s — and unknown paths answer exactly like
private ones (minimal 401 JSON), so the route table is not an oracle.

| Path | Methods | Class | Notes |
| --- | --- | --- | --- |
| `/health` | GET | PUBLIC | `{status:'ok'}` only; never counts, migrations or providers. |
| `/auth/config` | GET | PUBLIC | The four Firebase identifiers only. |
| `/payments/config` | GET | PUBLIC | Availability flags only. |
| `/stops`, `/places`, `/routes` | GET | PUBLIC | Catalogue reference data; metered per client address. |
| `/services`, `/services/:id/availability` | GET | PUBLIC | Departures, stops, fares, seats; no phones, emails or identities. |
| `/public/parcel-tracking/:ref` | GET | PUBLIC | Safe projection only — never parties, phones or payment data. Rate-limited. |
| `/assistant` | POST | PUBLIC (limited) | Anonymous callers get the public surface only; per-address rate limit. |
| `/auth/demo` | POST | INTERNAL | Refused (404) whenever `demoLogin` is off — production included. |
| `/me` | GET/PATCH | AUTHENTICATED | Own profile; privilege fields never accepted. |
| `/me/bookings`, `/me/parcels` | GET | AUTHENTICATED | Own data only. |
| `/bookings`, `/bookings/:id/*`, `/payments/:id/*` | GET/POST | AUTHENTICATED | Ownership enforced; server-controlled amounts. |
| `/parcels/quote`, `/parcels`, `/parcels/:id/*` | GET/POST/PATCH | AUTHENTICATED | Ownership or assigned crew; rate rules fail closed. |
| `/notifications`, `/notifications/preferences`, `/notifications/:id` | GET/PUT/PATCH | AUTHENTICATED | Per identity. |
| `/onboarding/*` | GET/POST/PATCH | AUTHENTICATED | One-time identity transitions. |
| `/mobility/providers`, `/mobility/handoff` | GET/POST | AUTHENTICATED | Suggestion analytics; no completed-ride claims. |
| `/tickets/verify` | POST | ROLE_RESTRICTED | Assigned crew only; digest-only credentials. |
| `/incidents`, `/incidents/:id` | GET/POST/PATCH | ROLE_RESTRICTED | Crew/ops, operator-scoped. |
| `/driver/*` | GET/POST | ROLE_RESTRICTED | Driver/convoyeur, assignment-scoped. |
| `/ops/*` | GET/POST/PATCH | ROLE_RESTRICTED | Ops, operator-scoped; platform-only where noted (`/ops/health`, `/ops/model-usage`). |
| `/operator/settlements`, `/operator/payouts/*` | GET/POST | ROLE_RESTRICTED | Own operator; company staff cannot withdraw. |
| `/ops/fare-intelligence`, `/ops/fare-observations`, `/ops/plan` | GET/POST | ROLE_RESTRICTED | Ops only; aggregates never cross the operator boundary. |
| `/webhooks/fedapay` | POST | WEBHOOK | Signature verified per FedaPay's official scheme before anything correlates; unknown events answered 200-ignored; anomalies audited. |
| `/ussd/webhook/:provider` | POST | WEBHOOK | Provider must equal the configured one; size cap, throttle, replay suppression. |
| `/agent/*`, `/workflows/*` | GET/POST | AGENT | Separate principal namespace with scopes; approvals tenant-bound; workflows never runnable by humans. |
| `/workflows/tick` | POST | AGENT | The only agent endpoint the worker calls; scope `workflow.run`. |

## Cross-cutting controls

- **Methods**: a known path with an unsupported method answers 405 before any
  other check; unknown paths answer minimally (401/404) with no internals.
- **Bodies**: JSON only, 16 KiB cap, object-only; the assistant caps messages
  at 1 000 characters. Malformed input never reaches domain code.
- **Rate limits**: per-identity on every mutation, per-address on the public
  catalogue, public tracking, demo login, USSD callers and the assistant
  (120/min buckets in `request_limits`).
- **Errors**: stable codes, sanitized messages, `x-request-id` correlation;
  server logs carry codes only. Tokens, queries and payloads are never logged
  or echoed.
- **CORS**: exact origin allowlist from `CORS_ORIGINS`; webhooks need no
  browser CORS. OPTIONS answers the allowed methods/headers explicitly.
- **Headers**: `content-type`, `cache-control: no-store`, `nosniff`, `DENY`
  framing, `no-referrer`, minimal CSP `default-src 'none'` on the API; HSTS
  added by the platform edge.
- **Enumeration**: parcel references are 4-byte random with per-address
  limits; bookings/payments are unguessable UUIDs owned by the caller;
  unknown and private paths answer identically.
