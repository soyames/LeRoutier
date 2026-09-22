# Telling somebody something

LeRoutier has had a complete notification system for a while — domain events,
policies, a queue, exponential backoff, dead-lettering, a per-attempt audit
trail, and in-app delivery that always works because it is served from our own
database. What it has never had is a way to reach somebody who is not looking
at the app.

This file is about that last mile, and about the one honest fact underneath it:
**no external channel is enabled today.**

## What is already true

| | |
|---|---|
| `in_app` | always available — it is a row in our database, not a provider |
| `email` | **unavailable** until a provider is configured |
| `sms` | unavailable, and see below |
| `whatsapp` | unavailable, and see below |
| `web_push` | unavailable |

An unavailable channel is recorded as `unavailable` against the delivery, never
as sent. Platform Ops reads the real state from `GET /ops/diagnostics`, which
derives it from the adapters that actually exist rather than from a flag.

## Why email, and why Brevo

The pilot is in Benin, the users sign in with Google, and the account record
already carries a verified `notification_email` taken from the sign-in token.
Email is therefore the only channel whose recipient data the platform already
holds.

It is also the only one that can be switched on **without activating billing
anywhere**, which is a standing constraint on this project:

- **SMS** to Benin is metered by every provider worth using. There is no free
  tier that reaches a Beninese number.
- **WhatsApp** needs a Meta Business account, a registered number and template
  review before a single message can be sent. That is a commitment, not a
  configuration change.
- **Brevo** gives 300 transactional emails a day, permanently, with no credit
  card and full REST API access on the free plan.

300 a day is comfortably more than a controlled pilot sends, and the ceiling is
a daily reset rather than a monthly pool, which suits notification traffic —
it trickles.

## What is implemented

`packages/database/src/notification-providers.js` carries two adapters behind
one contract. Nothing about the queue, the retry policy, the audit trail or
the event catalogue changed; this is a transport.

```
GATEWAY  EMAIL_PROVIDER_URL + EMAIL_PROVIDER_KEY
         A relay the owner runs, speaking LeRoutier's own contract. Kept,
         because it is the only shape that can reach a channel nobody has
         written an adapter for.

BREVO    EMAIL_PROVIDER=brevo + BREVO_API_KEY + EMAIL_FROM_ADDRESS
         Speaks Brevo's REST API directly. No relay to run.
```

Both compose their message through the same function, so the wording, the
recipient rule and the refusals cannot drift apart between transports.

### What the adapter refuses

- a **TEST identity** never reaches the provider — the request is not made at
  all, rather than made and discarded;
- a **disabled account** likewise;
- a recipient with **no address** is `unavailable`, not a failure retried
  forever;
- **any non-2xx** from the provider throws, so the dispatcher retries and the
  delivery is never recorded as sent;
- a **plaintext relay URL** is refused rather than used.

### On idempotency, precisely

The dispatcher passes `delivery.id` — stable across retries — and only retries
deliveries it did **not** observe the provider accept. A delivery recorded as
`sent` is never retried.

Brevo has no idempotency-key header, so one window remains: the provider
accepts and the process dies before recording it, after which the retry sends
again. That is at-least-once, and it is the right trade here. A passenger
receiving their ticket confirmation twice is a nuisance; never receiving it is
a passenger at a station without a ticket.

The gateway contract still receives the `Idempotency-Key` header and is still
expected to deduplicate on it.

## Events that already exist and would carry

No new business event was invented to justify a channel. These are already
emitted and already have policies:

KYC submitted · KYC rejected · correction requested · operator verified ·
booking confirmed · payment confirmed · departure and service changes ·
cancellation · parcel accepted · parcel movement · parcel ready for pickup ·
payout requested · payout completed · payout failed.

## EXTERNAL ACTION REQUIRED

This is the blocker, and it cannot be done from the repository — creating an
account is the owner's to do, not the agent's.

1. Create a **Brevo** account on the free plan. No card.
2. Wait for Brevo to **approve the account for sending**. New accounts cannot
   send until this happens, and it is not instant.
3. **Verify the sender**: either the single address `EMAIL_FROM_ADDRESS` will
   use, or the whole `leroutier.app` domain. Domain verification needs DNS
   records and gives materially better deliverability — worth doing before a
   pilot, since a confirmation in a spam folder is a confirmation nobody read.
4. Create an API key.
5. Set on `le-routier-api`, production and preview:

   | Variable | Value | Type |
   |---|---|---|
   | `EMAIL_PROVIDER` | `brevo` | plain — it is configuration |
   | `BREVO_API_KEY` | the key | **Sensitive** |
   | `EMAIL_FROM_ADDRESS` | the verified sender | plain |
   | `EMAIL_FROM_NAME` | `LeRoutier` | plain |

6. Confirm: Platform Ops → `GET /ops/diagnostics` should report
   `channels.email: true`. Until then it reports `false`, which is the truth.

Do **not** enable a paid plan, a paid SMS provider, or WhatsApp Business
without deciding to. The system is designed to say "unavailable" indefinitely
without anybody being misled, which is the point.

## Testing

`services/api/tests/brevo-provider.test.js` drives the adapter against a fake
transport — a function, not the network. **No test sends a real message**, and
the TEST-identity refusal is asserted by checking the request was never made.
