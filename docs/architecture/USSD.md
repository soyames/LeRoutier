# USSD

A feature phone with no data plan is still the most common way to reach a bus
in Benin. USSD makes LeRoutier answer that phone.

**USSD is a channel, not a second application.** It has no booking engine, no
capacity rules, no fare arithmetic and no payment truth of its own. Every screen
asks the same domain services the PWA asks, and shows what they answer.

```
gateway callback
  → provider adapter          verify, normalise
  → session cursor            which screen, what was chosen
  → the same domain services the PWA uses
  → one screen of text
```

If a price or a seat decision is ever computed inside `services/ussd`, that is a
bug: it belongs in `packages/domain` or `packages/database`.

## What a caller can do

| Journey | Account needed |
| --- | --- |
| Trouver un trajet — origin, destination, real departures with real fares | no |
| Suivre un colis — by tracking reference | no |
| Aide — booking, payment, parcels, contact | no |
| Langue | no |
| Réserver — confirm, then pay or pay later | **yes** |
| Mes réservations — status and payment state | **yes** |
| Statut de mon voyage — service status, next stop, ETA | **yes** |

Deliberately absent: the whole PWA. USSD is for the essential journeys, on a
screen that fits about 182 characters.

### One booking is one seat

The domain's `hold` takes no seat count — a booking *is* a seat, on the web as
here. So USSD does not ask "how many places?", because offering a count the
product cannot honour would be inventing a capability. A second traveller makes
a second booking.

## Identity — the most important rule

**USSD never creates an identity, and never grants a role.**

A gateway sends an MSISDN. That proves the *gateway* sent it, not that the
person at the other end owns a LeRoutier account. So:

1. An account is bound only if the callback was **cryptographically verified**
   *and* `USSD_TRUST_PROVIDER_MSISDN=true`. Neither alone is enough.
2. Even then, the session is bound to an account that **already exists**,
   matched on the phone number in its passenger profile.
3. If no account matches, the caller is told how to create one on the web. They
   keep every anonymous journey.

A caller can therefore never become a driver, a convoyeur, or Ops through this
channel — there is no code path that assigns a role. Tested.

**The trust assumption, stated:** a verified callback means the gateway's shared
secret signed this body. Whether the MSISDN in it is the real caller depends on
the telecom's own integrity, which is the basis of mobile money and a reasonable
assumption — but it is *an assumption*, which is why it is opt-in and off by
default. Lifting it properly means OTP verification, which needs an SMS
provider LeRoutier does not yet have.

## Payment

Identical to the web, because it is the same code:

- USSD can **initiate** a payment.
- A payment becomes *payé* when a **verified provider webhook** says so.
- Pressing "1" never marks anything paid. The screen says
  *"Paiement en attente. Vous recevrez une confirmation."*

There is no cash option in passenger USSD, exactly as there is none in the PWA.

## Sessions

A session is a **cursor**, not a cache. It remembers which screen the caller is
on and what they selected — never a fare, a seat count or a payment status,
because a remembered price is a price that can be wrong by the time it is
confirmed, and a remembered capacity is an oversell waiting to happen. The
confirmation screen re-reads availability before it shows a total.

| | |
| --- | --- |
| Stored | provider, provider session id, **hash** of the phone, verified flag, bound user, locale, flow, step, cursor state, status |
| Never stored | the phone number, the gateway's raw payload, anything re-readable from the domain |
| Expiry | `USSD_SESSION_TTL_SECONDS`, default 180 s, pushed out on each screen |
| Expired | dialling again starts fresh — a half-finished booking whose price and availability have moved is not resumed |
| Cleanup | `engine.sweep()` closes expired sessions and drops old transcripts |

## Idempotency and replay

Gateways retry hard on timeout. A retried "confirm" must not book a second seat.

- Every answered request is recorded against a fingerprint of
  *(session, step index, input)*; a repeat returns the first answer byte for byte.
- The booking hold's idempotency key is derived from the session, so even a
  replay that reached the domain would return the original booking.

## Screens

182 GSM characters. Exceeding it does not wrap — the gateway truncates, and what
gets cut is the end of the screen, which is where the navigation lives. A
truncated screen is a dead end.

- **Navigation is reserved first**, before any body line is kept.
- Long lists **paginate** rather than truncate (`#` next, `*` previous).
- A notice like *"Choix invalide"* re-renders the screen with its own length
  already reserved, so the options survive the warning.
- `0` back, `00` quit — the same everywhere, so nobody learns a per-screen rule.

All French, from one catalogue in `messages.js`. Translating is a change to that
file alone.

## Security

| Threat | Control |
| --- | --- |
| Spoofed gateway callback | HMAC-SHA256 over the raw body, constant-time compare; a missing secret or signature never passes |
| MSISDN spoofing | an unverified callback can never bind an identity |
| Replay | per-request fingerprint returns the stored answer |
| Session hijack | sessions key on the gateway's own session id, scoped per provider |
| Reference enumeration | booking references are derived from UUIDs, not sequential; parcel tracking uses the existing public projection |
| Rate abuse | per-caller session throttle (hashed phone) **plus** the API's own limiter, on separate buckets |
| Injection through free text | input reaches SQL only as a bound parameter; references are pattern-checked |
| Cross-user leakage | a bound session reads only that passenger's bookings, through the same authorization the API applies |
| Oversized payload | 8 KB cap before parsing |
| Unknown provider | resolves to **no adapter**, never to the never-verifying sandbox |

Errors never reach a handset: a backend failure is *"Service momentanément
indisponible."* and nothing else.

Phone numbers are **hashed** for storage and **masked** in any operational
output. The raw number is never persisted — asserted by test.

## Latency

USSD sessions are short-lived and the gateway is impatient.

- Navigation is entirely deterministic — no model call is on the response path.
- The engine does one database transaction per screen.
- Model-assisted triage (`packages/agents`) may classify a *situation* after the
  fact; it is never a dependency of a menu.

## Configuration

Server-side only, on `le-routier-api`. Nothing USSD-related belongs on the PWA.

```
USSD_PROVIDER=                    # selects the adapter; unset ⇒ endpoint does not exist
USSD_API_KEY=                     # outbound calls, if the gateway needs them
USSD_WEBHOOK_SECRET=              # HMAC secret for inbound verification
USSD_SESSION_TTL_SECONDS=180
USSD_DEFAULT_LOCALE=fr
USSD_TRUST_PROVIDER_MSISDN=false  # see Identity above
```

**No new Vercel project and no new database.** The webhook lives inside
`le-routier-api`; the two tables live in the existing Neon database.

## Local development

No telecom contract required:

```bash
pnpm docker:up && pnpm db:local:migrate && pnpm db:local:seed
pnpm ussd:dev
```

A terminal handset against the real engine and the real local database.
`:state` inspects the session (the phone number is absent, because it is not
stored), `:new` redials, `:quit` exits.

## Provider onboarding checklist

Everything a gateway integration needs. An adapter is one object in
`services/ussd/src/adapters.js`; nothing else changes.

| What to obtain | Why |
| --- | --- |
| **Webhook URL** | `https://le-routier-api.vercel.app/api/v1/ussd/webhook/<provider>` |
| **HTTP method and content type** | JSON and form-encoded are both handled |
| **Authentication scheme** | header name, algorithm, and what exactly is signed — the raw body, or a canonical string |
| **Shared secret** | delivered out of band; goes in `USSD_WEBHOOK_SECRET` |
| **Session id field** | must be stable for the whole call |
| **MSISDN field** | and whether the gateway guarantees it |
| **Input field** | and **whether it accumulates** (`1*2*3`) or sends only the latest press — the adapter handles both, but it must be known which |
| **Continue / end format** | `CON`/`END` prefixes are the common convention |
| **Max response length** | 182 assumed; confirm |
| **Timeout** | how long before the gateway gives up |
| **Retry policy** | how many times, how fast — this is what replay protection is sized for |
| **IP allowlist** | if offered, take it |
| **Shortcode** | the number a caller dials |

## Operators and routing

Allocation is regulatory; **reach is commercial**. A code works on the networks
that agree to route it, so the architecture assumes several and commits to none.

```
UssdProviderAdapter
├── mtn        MTN Benin — implemented, contract unconfirmed
├── generic    aggregator / HMAC gateway — implemented
├── sandbox    simulator and tests — never verifies, by design
├── moov       not implemented — no contract
└── celtiis    not implemented — no contract
```

**One MTN API is not all-network USSD.** Moov Africa and Celtiis/SBIN are
separate commercial relationships and separate adapters. No adapter is activated
without a real contract, and nothing claims multi-network reach until it has
been dialled.

The aggregator route is kept deliberately open: if an aggregator can lawfully
route one ARCEP-assigned code across several operators, that is one contract and
one adapter instead of three — judged on coverage, cost per session, webhook
contract, **MSISDN guarantee**, uptime, retry behaviour and support.

### MTN Benin

MTN's inbound shape is not the `CON`/`END` convention most aggregators use:

| Field | Meaning |
| --- | --- |
| `sessionId` | stable for the whole call |
| `messageType` | 0 Begin · 1 Continue · 2 End · 3 Notification · 4 Cancel · 5 Timeout |
| `msisdn` | the subscriber |
| `serviceCode` | the shortcode, e.g. `*1234*356#` |
| `ussdString` | message content; on cancel, the reason |

`messageType` is the part worth having — MTN states outright whether this is
the first screen, a continuation, or a call already ended. The engine closes the
session on End, Cancel and Timeout rather than rendering into a dead channel.

Two details that would otherwise be bugs: on **Begin**, `ussdString` carries the
dialled shortcode (`*1234*356#`), which is not an answer to any question — so
the first screen receives no input. And the reply carries its continuation
decision as a `messageType`, not a text prefix.

> ⚠️ **The field mapping is not yet confirmed against the portal's own Swagger.**
> It follows MTN's published API description; the specification itself sits
> behind developer-portal authentication, and Benin is served by
> `appx.developers.mtn.com` rather than the main portal. `mtnAdapter.contract`
> lists every field the adapter depends on so confirmation is one diff, the
> contract tests pin each name, and `contract.confirmed` is `false` until
> someone has actually checked.
>
> The inbound verification scheme is **not guessed**: until MTN's is confirmed,
> `verify()` accepts only an explicitly configured shared secret and fails
> closed otherwise — so an unconfirmed callback can never bind an identity.

### Session and response limits

ARCEP-approved operational limits, carried as defaults rather than as targets:

| | Regulator ceiling | LeRoutier target |
| --- | --- | --- |
| Session | 120 s | a call is a few screens |
| Response | 60 s | **under 2 s** for deterministic menu actions |

No model call is on the response path, ever. Navigation is entirely
deterministic and the engine does one database transaction per screen.

## Shortcode

**LeRoutier has no shortcode**, and nothing in the product claims one.

Obtaining one is regulatory and commercial work, prepared in
[`../operations/USSD_ARCEP_APPLICATION.md`](../operations/USSD_ARCEP_APPLICATION.md):
an SVA declaration is a prerequisite, the fees are published, and the allocation
list has been checked so no already-allocated code is proposed — `*601#` is
FedaPay's, and LeRoutier must not route through it as though it were its own.

### Status

| | |
| --- | --- |
| `USSD_CODE` | **READY** |
| `USSD_INTERNAL_ENGINE` | **READY** — journeys, sessions, security, tests |
| `USSD_PROVIDER_ADAPTER` | **READY (unconfirmed)** — sandbox, generic HMAC and MTN implemented; MTN's field mapping awaits the portal Swagger |
| `USSD_ARCEP_CODE` | **PENDING** — application pack prepared, nothing submitted |
| `USSD_OPERATOR_ROUTING` | **PENDING** — no operator or aggregator contract |
| `USSD_REAL_HANDSET_TEST` | **PENDING** — impossible before a code and routing exist |

USSD is **not production live**.
