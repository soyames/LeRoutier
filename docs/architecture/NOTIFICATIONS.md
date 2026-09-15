# Notification architecture

Notifications are infrastructure, not screen decoration. One path carries every
message in the product:

```
domain event (outbox)
  -> notification policy   (event_type + payload match -> audience, category, template, channels)
  -> recipient resolution  (audience -> identities or contacts)
  -> channel resolution    (availability + preference, in_app always last)
  -> delivery record       (pending | sent | failed | unavailable | suppressed)
```

## No second event bus

The existing `outbox` table remains the only domain event stream. Dispatch is a
hook on the same drain the workflow engine already uses
(`createWorkflowEngine({ onEvent })`), so ordering, locking and at-least-once
delivery are inherited rather than reinvented.

`audit()` publishes every audited action to the outbox under its own action
name, and carries its `details` in the event payload. Policies can therefore
match real domain facts without a module emitting the same event twice — when
adding an emitter, check whether `audit()` already publishes that name.

Dispatch runs in its own transaction inside the drain. A provider outage or a
malformed policy can never roll back the business transaction that produced the
event, and never stalls the queue.

### Exactly once

`notifications_once` is unique on `(policy_id, event_type, entity_id, recipient)`.
Replaying the outbox — which happens whenever a workflow is retried — cannot
produce a duplicate notification.

## Categories and severity

| Category | Examples | Can be switched off |
| --- | --- | --- |
| `critical` | payment succeeded/failed, cancellation, boarding-point change, major delay, parcel ready for pickup, payout failure | No — mandatory |
| `operational` | booking created, boarding soon, departure reminder, parcel handover, first-mile timing | Yes |
| `marketing` | promotions, recommendations | Yes, and opt-in by design |

Marketing never shares a policy, a template or a channel decision with
operations. `severity` (`info`, `warning`, `urgent`) drives presentation only.

## Channels

`in_app`, `web_push`, `sms`, `whatsapp`, `email`.

`in_app` is always available because LeRoutier serves it from its own database,
and it is always appended last so a recipient with an account never loses a
message. Every outbound channel requires real provider credentials
(`SMS_PROVIDER_*`, `WHATSAPP_PROVIDER_*`, `EMAIL_PROVIDER_*`, `WEB_PUSH_*`).

**Unconfigured channels fail closed.** They are recorded as `unavailable` with
the reason, never as `sent`, and never silently dropped. No provider is
currently configured in production, so outbound delivery is genuinely pending an
external dependency — the product does not pretend otherwise.

## Recipients

Audiences are resolved in code, because walking from an event to the people who
should hear about it is domain logic, not configuration:

| Audience | Resolution |
| --- | --- |
| `booking_passenger` | the booking's passenger |
| `service_passengers` | every passenger holding an active booking on the service |
| `service_driver_independent` | the assigned driver who owns the independent operator |
| `service_driver_company` | the assigned driver of a company operator |
| `service_convoyeur` | the assigned convoyeur |
| `operator_ops` | Ops users of that operator |
| `platform_ops` | Ops users with no operator (platform moderation) |
| `operator_owner` | the owner of an independent operator |
| `parcel_sender` / `parcel_receiver` | the parcel party's phone contact |
| `point_proposer` | whoever proposed the boarding point |

Parcel parties are phone contacts rather than identities, so they receive no
in-app row — only outbound channels, which stay unavailable until a provider is
configured.

## Role separation is structural

Company drivers are crew, not revenue owners. **No policy in the catalogue
targets `service_driver_company` with a settlement, payout or revenue event.**
This is enforced by the catalogue itself and asserted by a test that queries the
policy table, not by filtering at render time.

Convoyeur policies are distinct from driver policies and use crew wording
(manifest, walk-up, parcel handover, next station, cash reconciliation).

Ops receives exceptions only — cancellations, disruptions, incidents, payment
and payout anomalies, lost/damaged parcels, moderation backlog — never the
normal flow.

## Privacy

Notification payloads are filtered to an explicit safe key list. Pickup codes,
ticket tokens and another party's contact details are never copied into a
notification, on any channel. Public parcel tracking rules are unchanged.

## Superseding, not contradicting

Timing advice replaces itself. When a service is rescheduled, the new
recommendation marks the previous one `superseded_at`, and the notification
centre hides superseded rows. A passenger never holds two different "leave at"
times.

## Preferences

`GET/PUT /api/v1/notifications/preferences`. Users choose channels per category
for non-mandatory notifications. Mandatory categories are reported as `locked`,
and an attempt to disable one is rejected rather than stored as a preference the
dispatcher would ignore.

## Time-based reminders

`first_mile.leave_soon` and `boarding.starts_soon` are the only notifications
not triggered by a state change. The worker tick raises them as ordinary outbox
events so they travel the same path as everything else, keyed by the computed
time so a reschedule legitimately raises fresh, superseding advice while a
repeated tick is a no-op.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/v1/notifications` | the caller's own notification centre |
| `POST /api/v1/notifications/:id/read` | mark read (own notifications only) |
| `GET /api/v1/notifications/preferences` | channels, categories, locked flags |
| `PUT /api/v1/notifications/preferences` | set one category/channel preference |

## Remaining external dependency

SMS, WhatsApp, email and web-push providers are not configured. Until they are,
every outbound delivery is recorded `unavailable` and only the in-app centre
actually reaches people who have an account.
