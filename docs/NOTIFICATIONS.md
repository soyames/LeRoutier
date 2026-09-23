# Telling somebody something

LeRoutier has had a complete notification system for a while — domain events,
policies, a queue, exponential backoff, dead-lettering, a per-attempt audit
trail, and in-app delivery that always works because it is served from our own
database. Email is a transport bolted onto the side of that. It is not, and
must never become, where LeRoutier's state lives.

**The application is the source of truth. The inbox is a courtesy.**

## The constraint everything else follows from

Brevo Free sends **300 emails a day**, permanently, with no card. That is
comfortable for a controlled pilot and nowhere near enough to email somebody
every time a vehicle reaches a stop. Two consequences run through this whole
design:

1. **Email is selective.** 17 of 75 policies carry it. The other 58 are in-app
   only and cost nothing.
2. **Running out is a normal state, not an incident.** It must not retry-storm,
   must not fail a booking, and must not show a passenger a provider's error.

## Which events get an email

Stored on each policy in `notification_policies.channels`, beside the event —
not decided in code. `importance` decides what survives when the day's
allowance is nearly spent.

### high — somebody must act, or something they planned has changed

| Event | Who |
|---|---|
| `booking.cancelled` | passenger |
| `service.status` (cancelled) | passengers on the service |
| `service.rescheduled` | passengers on the service |
| `service.boarding_point_changed` | passengers on the service |
| `payment.failed` | passenger |
| `payout.failed` | driver |
| `operator_payout.failed` | operator owner |
| `operator.evidence_reviewed` (rejected) | operator owner |
| `operator.verification_changed` (rejected / suspended) | operator owner |
| `parcel.ready_for_pickup` | receiver |

### normal — the record of something that worked

| Event | Who |
|---|---|
| `booking.confirmed` → `ticket_ready` | passenger — **the combined message, see below** |
| `operator.verification_changed` (verified) | operator owner |
| `payout.paid` | driver |
| `operator_payout.paid` | operator owner |
| `parcel.accepted` | sender |

### optional — pleasant, and the first thing dropped

| Event | Who |
|---|---|
| `parcel.collected` | sender |

### in-app only, deliberately

Position, progress, custody and internal state. High frequency, low value in an
inbox, and the fastest way to spend 300 messages before lunch:

boarding · alighting · arrival · seat held · walk-up sale · next station ·
recovery · crew reschedule · parcel loaded, in transit, arrived, delayed, ETA ·
crew load and unload lists · settlement credited · point moderation · every
incident and Ops state · every technical signal.

A test asserts none of these ever acquires an email channel.

## One booking, one email

A successful purchase produces **one** message, not three. `booking.confirmed`
fires once payment is confirmed, and the `ticket_ready` template already
carries the whole transaction:

- the trip, the boarding point and the departure time
- the seat
- **the amount paid** and any refund recorded
- a link to the ticket, the invoice and the receipt

So `payment.succeeded`, `booking.held` and `passenger_boarded` deliberately do
**not** get an email. Documents are linked rather than attached, because
LeRoutier already serves them securely from the application and an attachment
is a copy nobody can revoke.

## Quota awareness

### What Brevo tells us, and what it does not

| | |
|---|---|
| `x-sib-ratelimit-remaining` / `-reset` | request-rate budget, returned on **every** response — recorded |
| HTTP 402 / `not_enough_credits` | the allowance is spent — authoritative, and acted on |
| a per-day remaining balance | **not exposed on the free plan** |

Because that last one does not exist, LeRoutier counts its own accepted sends
since midnight UTC from its own delivery ledger. It is labelled
`leRoutierSentToday` everywhere it appears, and the remaining figure is labelled
*estimated*, because presenting our tally as Brevo's balance would be inventing
a provider metric. The provider's own refusal stays authoritative when it comes.

### Pressure states

Computed from usage against `EMAIL_DAILY_QUOTA` (default 300). Provider trouble
outranks usage — a wrong credential matters more than a quiet day.

| State | Meaning |
|---|---|
| `healthy` | under 70% |
| `warning` | 70–84% |
| `high` | 85–94% — optional email stops |
| `critical` | 95%+ — only `high` importance is sent |
| `quota_exhausted` | the day's allowance is gone |
| `provider_rate_limited` | asked to slow down |
| `provider_unavailable` | the provider erred or was unreachable |
| `configuration_error` | credential or sender rejected |

Thresholds are configuration (`emailQuotaThresholds`), not constants.

### Preserving capacity

When pressure reaches `high`, optional email stops. At `critical` or
`quota_exhausted`, only `high` importance is sent. **Only the email is dropped**
— the notification is still created, still delivered in-app, and still read
exactly as before. The underlying application event is never suppressed.

## When sending fails

Five different things go wrong, and treating them as one "it failed" is how an
allowance of 300 turns into 1,500 refused requests.

| Reason | Retry the message? | Stop the channel? |
|---|---|---|
| `quota_exhausted` | yes, after the daily reset | yes, until the reset |
| `rate_limited` | yes, after the provider's own delay | yes, briefly |
| `provider_unavailable` | yes — existing backoff and dead-letter | no |
| `invalid_configuration` | **no** — no retry fixes a wrong key | yes, until a success clears it |
| `recipient_rejected` | **no** | **no** — one bad address must not stop everybody's mail |

A message deferred for quota is **not failed**. It is going to be delivered,
after the reset. While the channel is suppressed the dispatcher does not call
the provider at all — that single check is what turns a storm into one deferred
message.

The existing queue, retry, backoff and dead-letter semantics are unchanged for
everything that genuinely warrants a retry.

## What a user sees

Never a provider name, an HTTP status, a quota message, an API error, a
response body or a stack trace. Users see LeRoutier's own words, and the
transaction is always authoritative:

> Your booking is confirmed and available in LeRoutier. External sending is
> temporarily unavailable.

- a booking stays confirmed if the email fails;
- a payment stays confirmed;
- a KYC decision stays visible in-app;
- a payout state stays authoritative;
- a ticket stays accessible inside the app.

**Email failure never rolls back a business transaction**, and LeRoutier never
claims a message was sent when it was not. A test asserts that no delivery
record or attempt row contains provider terminology.

## Sender configuration

Transactional mail is sent as **`LeRoutier <noreply@leroutier.app>`**.

Verified from public DNS on 2026-09-22, independently of the Brevo dashboard:

| Record | State |
|---|---|
| `brevo1._domainkey` → `b1.leroutier-app.dkim.brevo.com` | resolves; Brevo publishes a 2048-bit RSA key |
| `brevo2._domainkey` → `b2.leroutier-app.dkim.brevo.com` | resolves; 2048-bit RSA key |
| `_dmarc` | `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com` |
| domain ownership | `brevo-code:…` TXT present on the apex |
| **SPF** | **absent** — see below |
| **MX** | **absent** — `noreply@` cannot receive mail |

Two things follow.

**No SPF record exists.** DMARC still passes, because DKIM aligns on
`leroutier.app` and DMARC needs only one aligned mechanism. But some receivers
weight SPF, and adding `v=spf1 include:spf.brevo.com -all` to the apex TXT would
strengthen deliverability. Not done here: it is a DNS change and nobody asked
for one.

**`noreply@leroutier.app` cannot receive a reply.** There is no MX record, so a
reply does not go unread — it fails at the sender's own provider, quietly, while
the passenger believes they have asked for help. Every message therefore says so
and names the existing support route, `leroutierbj@gmail.com`, defined once in
`packages/notifications/src/content.js` and shared with the assistant.

## Configuration

| Variable | Value | Type |
|---|---|---|
| `EMAIL_PROVIDER` | `brevo` | plain — configuration |
| `BREVO_API_KEY` | the key | **Sensitive** |
| `EMAIL_FROM_ADDRESS` | `noreply@leroutier.app` | plain |
| `EMAIL_FROM_NAME` | `LeRoutier` | plain |
| `EMAIL_DAILY_QUOTA` | `300` (default) | plain |

The account already exists, the sender is verified and the domain is
authenticated. **Do not create a second sender, a second API key, or duplicate
variables.** Do not enable a paid plan, SMS credits, WhatsApp, or billing.

### EXTERNAL ACTION REQUIRED

The Brevo **API key value** is not available to this repository. The file
supplied for verification contains the SDK sample with the literal placeholder
`'YOUR_API_V3_KEY'`, Brevo's *"key has been generated"* confirmation, the SMTP
host and login, and the DKIM record — but not the key itself. Nothing here can
authenticate to Brevo until it is set.

1. Copy the API key from Brevo (or generate one if it was never saved — that
   replaces the unused key rather than adding a second sender).
2. Set `BREVO_API_KEY` on `le-routier-api`, production and preview, as
   **Sensitive**, together with the three plain values above.
3. Confirm on Platform Ops → **Système** → *Notifications par e-mail*:
   channel available, provider `brevo`, allowance 300.

Until then `channels.email` is `false`, every surface says so, and in-app
delivery carries everything.

## Rotating the Brevo API key

Brevo shows a key once. There is no way to read an existing one back, so
"rotate" always means "create a new one and replace the stored value".

1. Brevo → **SMTP & API** → **API keys** → *Generate a new API key*.
2. Set it on `le-routier-api`, production, as **Sensitive**. Replace the
   existing `BREVO_API_KEY` rather than adding a second variable:

   ```bash
   vercel env rm BREVO_API_KEY production --yes
   vercel env add BREVO_API_KEY production --sensitive
   # paste at the prompt; do not pass --value, which puts the secret in shell history
   ```

3. Delete the old key in Brevo.
4. Redeploy — a running deployment keeps the environment it started with:

   ```bash
   vercel redeploy <current-production-url>
   ```

5. Confirm on Platform Ops → **Système** → *Notifications par e-mail*: channel
   available, provider `brevo`, allowance 300.

**Do not create a second sender** while doing this. The sender is separate from
the key: `LeRoutier <noreply@leroutier.app>` is verified, `leroutier.app` is
authenticated, and rotating a key does not touch either.

If the channel reports unavailable after a rotation, the usual cause is not the
key. `brevoAdapter` requires **both** `BREVO_API_KEY` and `EMAIL_FROM_ADDRESS`;
with only one of them it returns no adapter at all and email stays honestly
unavailable rather than failing on the first send.

## How Platform Ops sees it

The existing **Système** screen, beside the database and the evidence store —
not a second dashboard. Non-sensitive only: counts, one state word, timestamps.

In-app availability · email availability · provider · configured allowance ·
LeRoutier's send count today · estimated remaining and percent used · pressure
state · suppression and until when · last successful delivery · failure
categories over 24 hours.

Never: the API key, a recipient address, a subject, a body, a signed link, a
provider message, or any KYC content.

## Moving to another plan or provider later

Business-event logic does not change.

- **A bigger Brevo plan** — raise `EMAIL_DAILY_QUOTA`. Nothing else.
- **A different provider** — add an adapter beside `brevoAdapter` in
  `notification-providers.js` returning the same `{accepted, reason,
  suppressUntil, rateLimit…}` shape, and name it in `EMAIL_PROVIDER`. The
  policy catalogue, the importance rules, the quota accounting, the console and
  every refusal stay exactly as they are.
- **A relay you run** — the original `EMAIL_PROVIDER_URL` / `_KEY` gateway
  contract is still supported and still deduplicates on `Idempotency-Key`.

## Testing

`services/api/tests/brevo-provider.test.js` and
`packages/database/tests/email-policy.test.js`, both against fakes and TEST
identities. **No test sends a real message.**

A TEST identity is refused as *"nobody to send to"* rather than as a provider
failure — deliberately, because a throw would retry five times and let TEST
data suppress real people's email. The refusal is asserted by checking the
request was never made at all.
