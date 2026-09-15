# First mile, last mile and the journey timeline

LeRoutier is not only the intercity leg. The passenger journey is:

```
home / current location
  -> first-mile local transport        (optional, external)
  -> exact intercity boarding point    (canonical registry)
  -> intercity journey                 (LeRoutier)
  -> arrival boarding point            (canonical registry)
  -> last-mile local transport         (optional, external)
  -> final destination
```

Only the middle is ours. The ends are assistance, and the product says so.

## One location model

First and last mile reuse the existing `boarding_points` registry and the
service's `departure_point_id` / `arrival_point_id`. There is no parallel
location model, no separate "pickup address" table, and no coordinates invented
for a point that does not have them.

## Gozem is a suggestion, not an integration

There is **no Gozem API integration**. Gozem is stored in `mobility_providers`
with `integration_status = 'suggested_external'`, and every response carries:

```json
{ "integrationStatus": "suggested_external", "handoff": "external_link",
  "booksRide": false, "providesFareEstimate": false, "providesEta": false }
```

Consequently LeRoutier never claims to book the ride, never shows a Gozem fare,
and never shows a Gozem ETA. The handoff order is:

1. an official app/universal link, **if verifiably supported** — no undocumented
   deep-link parameters are invented, so today this is the official landing URL;
2. the provider's web/app landing page;
3. a generic directions link built from the boarding point's own coordinates.

The provider abstraction (`id`, `name`, `country`, `capabilities`, `launchUrl`,
`handoff`, `integrationStatus`) is future-ready: when a real integration exists,
the row flips to `integrated` and `handoff` becomes `in_app_booking` without a
product rewrite. Nothing is hardcoded around Gozem — other countries will have
other providers, selected by the operator's country.

## Leave-home time

One configurable policy, not buffers invented per screen
(`FIRST_MILE_POLICY`, overridable via `FIRST_MILE_*` environment variables):

| Setting | Default | Meaning |
| --- | --- | --- |
| `boardingOpensMinutes` | 20 | boarding starts this long before departure |
| `recommendedArrivalMinutes` | 15 | be at the point by this long before departure |
| `boardingClosesMinutes` | 5 | boarding closes this long before departure |
| `safetyBufferMinutes` | 10 | slack added to the local trip |
| `defaultLocalTravelMinutes` | 25 | used when no estimate is supplied |

Worked example — departure 07:30:

```
boarding opens   07:10
be there by      07:15
local travel     25 min (estimate)
safety buffer    10 min
leave home       06:40
```

### Estimates are labelled

LeRoutier has no live routing provider. `travelSource` is either
`policy_default` or `client_estimate`, and `estimated` is always `true`. The
passenger app may compute a sharper local estimate from a straight-line distance
**on the device**, so their coordinates never reach the server; it passes only a
minute count, which is never stored.

Arrival time is reported as `arrivalScheduled: false` when the operator has not
scheduled one. It is never guessed.

## Delay recalculation

Ops reschedules through `POST /api/v1/services/:id/schedule`, which emits
`service.rescheduled` (and `service.boarding_point_changed` when the point
moves). The timeline recomputes from the new departure, and the new
recommendation **supersedes** the previous one rather than contradicting it:

```
before   "Leave around 06:40"
after    "Your departure is delayed. You can leave around 07:05."
```

Exactly one live timing recommendation exists per booking at any moment.

## Journey timeline

`GET /api/v1/journeys/:bookingId/timeline` (own bookings only) returns steps
derived from real booking, service and boarding-point state:

| Step | Source |
| --- | --- |
| `booking_created` | `bookings.created_at` |
| `payment` | succeeded payments against the booking |
| `ticket_ready` | issued ticket credential |
| `leave_for_boarding_point` | computed advice, marked `estimated` |
| `boarding_opens` | service schedule and `current_sequence` |
| `departure` | service status |
| `arrival` | `services.arrival_at`, or explicitly unscheduled |

No operational milestone is fabricated. A cancelled service marks every
remaining step cancelled rather than leaving stale advice on screen.

## Privacy

- The passenger's home or current location is **never** sent to the server,
  never stored, and never exposed to operators, drivers, convoyeurs or public
  tracking. Operators only ever need the official boarding point.
- `mobility_handoff_events` deliberately has no coordinate, address or
  destination column — a test asserts this.
- Distance and travel estimates are computed ephemerally on the device.

## Analytics

The funnel measures whether first-mile demand is real before anyone builds an
API integration:

```
first_mile suggestion_viewed -> handoff_clicked        (or directions_clicked / self_selected)
```

A click is a click. `recordHandoff` returns `rideCompleted: false` and there is
no code path that can set it true without a real integration.

## Failure and offline behaviour

First-mile assistance is never a dependency for boarding. If the provider,
network, map or location permission is unavailable, the passenger still gets the
exact boarding point name, its landmark, coordinates and a map link where
available, plus an explicit "I'll get there myself" path. `optional: true` is
part of the payload, not a UI convention.

## Not built

No local ride-hailing marketplace, no fare comparison, no ride tracking. The
goal is narrow: help people reliably reach and leave the intercity transport
point.

## Remaining external dependency

A real Gozem (or equivalent) API agreement. Until one exists, first and last
mile stay an external handoff.
