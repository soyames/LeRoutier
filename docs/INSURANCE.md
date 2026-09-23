# Insurance on LeRoutier

LeRoutier does not insure anybody. It shows an offer, takes a consent, hands a
partner the minimum they need, and records what they answered. Everything in
this document follows from that, and the code is written so that the alternative
is not reachable by accident.

## Why it has to work this way

Benin's insurance market runs under the **CIMA code** (Conférence Interafricaine
des Marchés d'Assurances, fourteen member states). Two rules decide the design:

- **Carrying risk needs an insurer's agrément.** Only a licensed company may
  underwrite. LeRoutier is a transport platform and will not be applying.
- **Selling cover needs an intermediary's registration.** Courtiers and agents
  généraux are registered, carry professional indemnity and a financial
  guarantee, and are supervised. A platform that collects a premium and takes a
  commission is intermediating whatever it calls itself.

There is a third rule that shapes the product more than either: under the CIMA
code, **cover does not begin until the premium is paid** — the "cash before
cover" principle. So a passenger who has ticked a box on LeRoutier is not
insured. They have asked to be. Saying anything stronger would be false, and it
is precisely the kind of false that a person discovers at the worst moment.

> Confirm the exact article references with the partner's compliance team before
> signing. The principles above are stable; the citations belong in the contract,
> not in a repository README.

**This is not the same "assurance" the operator already uploads.** An operator's
insurance certificate is a KYC document proving the vehicle is lawfully on the
road, and compulsory motor third-party cover protects other road users — not the
passenger's own loss, and not a parcel's contents. That gap is what this feature
addresses.

## The two integration depths

| | **referral** | **embedded** |
|---|---|---|
| Who shows the offer | LeRoutier | LeRoutier |
| Who takes the consent | LeRoutier | LeRoutier |
| Who issues the policy | partner | partner |
| **Who collects the premium** | **partner, directly** | LeRoutier, at checkout |
| Needs LeRoutier registered as an intermediary | **no** | **yes** |
| Available today | **yes — this is what the pilot runs** | no |

`insurance_partners.handoff` carries both values so the model is honest about
the difference, and `attach()` still moves no money in either case. When a
registration exists, the premium becomes another line in the payment flow that
already exists and `attach` gains one branch. Until then, an embedded partner
behaves exactly like a referral and the console says so.

## How LeRoutier gets an insurer to partner

The honest answer is that LeRoutier is not offering an insurer a favour, it is
offering them **distribution into a segment they currently cannot reach
profitably**. Intercity passengers and parcel senders in Benin are individually
low-premium and geographically dispersed; acquiring them one at a time through
an agent network costs more than the premium is worth. LeRoutier already has
them at the exact moment they are thinking about the risk.

What LeRoutier brings to the table, all of it already built:

- **Point-of-need distribution.** The offer appears beside the fare, while the
  passenger is deciding — not in a mailshot afterwards.
- **A verified counterparty.** Operators pass KYC/KYB before they can publish:
  identity, licence, transport authorisation, insurance certificate, roadworthiness
  and vehicle registration, reviewed by a person. An insurer pricing this risk is
  not pricing an anonymous informal fleet.
- **Structured, honest exposure data.** Real corridors, real departure times,
  real declared values, real seat counts. Parcel cover can be priced on a
  declared value the sender typed themselves.
- **Clean consent.** Versioned, timestamped, and recorded field-by-field, which
  matters to their own APDP position as much as to LeRoutier's.
- **No channel conflict.** LeRoutier will not become a broker, will not run a
  second insurer against them inside the same product without saying so, and
  will not touch claims.

What LeRoutier asks for:

1. The **agrément number**, entered in the console before the partner can be
   activated. The database refuses an active partner without one.
2. A **claims route that answers** — a phone number at minimum. It is shown to
   every covered person. An insurer nobody can reach is a policy that does not
   exist in practice.
3. **Cover terms in plain French**, including the two or three real exclusions.
   These are displayed at the point of choice, not buried in a PDF.
4. A **service level on answering requests**. Every hour a request sits at
   `requested` is an hour somebody is travelling uninsured while believing
   something is in motion.

Realistic first conversations, in rough order of ease: a **broker** already
placing motor fleet business with the operators onboarding to LeRoutier — they
understand the risk and the licence question is already answered; a **micro-insurance
or inclusive-insurance arm** of an established CIMA-zone insurer, for whom small
premiums at volume are the stated strategy; the insurer that already writes an
operator's fleet cover, extended to that operator's passengers. Starting with a
registered broker is the shortest path, because it solves distribution and
licensing in one counterparty.

## How a partner gets clients from the app

They do not log in. There is no partner portal, and adding one would be a second
console to secure, staff and keep correct for what is, at pilot scale, a handful
of requests a week. The flow is:

```
passenger/sender sees the offer  →  chooses it, consents
        │
        ▼
policy created  status = requested
        │
        ▼
Platform Ops → Assurances → Demandes
   shows the referral: exactly the consented fields, copyable
        │
        ▼
coordinator sends it to the partner, marks "transmis"
        │
        ▼
partner issues (or refuses) and returns their policy reference
        │
        ▼
coordinator records it  →  status = active (or declined)
        │
        ▼
the covered person is notified, in-app and by e-mail
```

The referral is assembled from a **fixed list in code** (`SHARED_FIELDS` in
[`insurance.js`](../packages/database/src/insurance.js)), not from whatever a
query happened to select — so it cannot grow when somebody adds a column to
`bookings`:

| trip | parcel |
|---|---|
| full name, phone, trip date, origin, destination, operator, cover amount | full name, phone, parcel reference, origin, destination, declared value, cover amount |

Not shared: the passenger's other journeys, their account, their payment method,
anybody else on the vehicle, or any KYC document.

**When volume justifies it**, the same states support a machine hand-off without
redesign: a signed webhook to the partner on `requested`, and a partner-authenticated
callback carrying their reference — the same shape as the FedaPay integration
already in this codebase. The manual path stays as the fallback, because a
partner whose endpoint is down must not stop somebody getting cover.

## How a user gets the offer and signs up

**At checkout, beside the fare.** `InsuranceOffer` renders after the seat picker
and before "Continuer vers le paiement". It is:

- **never preselected.** Nothing is opted in on somebody's behalf.
- **invisible when there is no partner.** With no active partner the component
  renders nothing — not an empty state, not a "coming soon". Advertising cover
  LeRoutier cannot sell would be the same lie in a smaller font.
- **priced honestly.** "Incluse" when the operator or insurer pays, the amount
  otherwise, and on a referral it says the premium is settled with the insurer
  and is not part of what LeRoutier is charging.
- **specific about the consent.** The sentence names the insurer, the purpose and
  the fields. "J'accepte les conditions" is not consent to a transfer of personal
  data to a third party.

**For a parcel**, the same block sits in the send flow, after the declared value —
which now has a field of its own. The declared value both feeds the carrier's
tariff (it always could; nothing ever sent it) and caps what can be insured.

**Afterwards**, the policy appears on the ticket and in the parcel detail with
one of four honest states:

| state | what the passenger is told |
|---|---|
| `requested` | "Votre demande est partie chez l'assureur. **Vous n'êtes pas encore couvert.**" |
| `active` | the insurer issued it — with the policy reference and the claims route |
| `declined` | refused, with the reason, and a plain statement that the trip and the payment are unchanged |
| `cancelled` / `expired` | withdrawn, or ended with the service it covered |

A request can be withdrawn in one tap. An **issued** policy cannot be cancelled
from LeRoutier — that is a contract with the insurer, and the product sends the
person to the party who can actually end it rather than pretending to.

## What happens when it fails

Insurance is an add-on in the literal sense: remove it and the transport is
unchanged. Every failure is contained.

- The attach call sits **outside** the try that governs the booking. An insurance
  request that fails never costs somebody their seat; they are told, and the
  journey continues to payment.
- A declined policy touches neither the booking nor its price. A test asserts the
  booking row is byte-identical before and after.
- No partner, no offer, no block — the component disappears.
- A claim is the insurer's process. LeRoutier does not instruct claims, and the
  UI says so where somebody might otherwise ask.

## Guardrails, and where each is enforced

Application code can be bypassed by the next caller. These are not.

| Rule | Enforced by |
|---|---|
| An active partner carries an agrément number | `CHECK` in migration 037 **and** `savePartner` |
| An active policy carries the insurer's reference | `CHECK` in migration 037 **and** `record` |
| One cover per booking, one per parcel | `UNIQUE (subject_type, subject_id)` |
| A premium mode has its own number and not the other | `CHECK insurance_product_premium_is_coherent` |
| Managing insurers is not KYC and not finance | `insurance` capability, `platform_grants` |
| Nothing leaves beyond the consented fields | `SHARED_FIELDS` constant, asserted by test |

A test reintroduces each of the first two by writing directly to the table, and
asserts PostgreSQL refuses.

## Notifications

Two events carry e-mail, both mandatory: `insurance.confirmed` and
`insurance.declined`. Both change what somebody believes about their own risk.
Requesting cover does not send one — the screen they are looking at already said
so, and [docs/NOTIFICATIONS.md](NOTIFICATIONS.md) explains why 300 messages a day
is not spent on things the user just did on purpose.

Both events are keyed on the **booking or parcel**, not on the policy, because
that is what resolves a recipient. Keyed on the policy they would resolve nobody
and be dropped silently — the worst possible failure for "your cover was refused".

## Data protection

The insurance add-on introduces a **new category of recipient** (the insurer or
broker) and a **new transfer of personal data**. That is a change to LeRoutier's
APDP position, not just a feature:

- consent is explicit, specific, versioned (`CONSENT_VERSION`) and timestamped;
- `shared_fields` records the **field names** transmitted, never the values — an
  audit trail must not become a second copy of somebody's personal data;
- the transfer happens only after the consent, and `shared_at` records when;
- withdrawal is available while the request is open.

The partner is a **separate controller**, not a subcontractor: they decide their
own purposes once the data reaches them, they answer their own claims, and they
have their own retention obligations under the CIMA code. The filing in
`docs/apdp/` reflects this.

## Setting up the first partner

1. Platform Ops → **Assurances** → Partenaires → *Enregistrer un assureur ou un
   courtier*. Leave it `draft`.
2. Add the agrément number and the claims phone. **Then** set it `active`.
3. Add one product. Keep the summary to a sentence somebody reads while deciding,
   and put the real exclusions in the exclusions field.
4. Set the product `active`. It is now visible at checkout.
5. Take one real request end to end — request, transmit, record the reference,
   confirm the passenger sees the policy number and the claims phone — before
   any of it carries a paying passenger. This is row-for-row the same discipline
   as [PAYMENT-GO-LIVE.md](PAYMENT-GO-LIVE.md).

**Do not** activate a partner without the agrément number, do not set `handoff`
to `embedded`, and do not promise a claims turnaround LeRoutier does not control.
