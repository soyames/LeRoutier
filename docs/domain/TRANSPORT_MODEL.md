# Transport Domain Model

This document establishes terminology before database implementation.

## Geographic hierarchy

`Place` represents an administrative/locality entity and may have a parent place. The hierarchy must be data-driven because administrative structures can change.

Typical Benin-oriented categories may include department, commune, arrondissement, village and urban neighborhood/quarter, but category definitions must not be embedded as irreversible schema assumptions.

## Stop

A `Stop` is a physical transport boarding/alighting point. It has coordinates and may be linked to one or more geographic places.

Examples: station, terminal, roadside pickup point, designated meeting point.

## Route

A `Route` describes an ordered transport path independent of a specific departure.

## RouteStop

A `RouteStop` associates a stop with a route and contains an ordinal position. Ordered RouteStops define the usable stop sequence.

## Segment

For route stops S0, S1, S2, ..., Sn, segments are:

- S0 → S1
- S1 → S2
- ...
- S(n-1) → Sn

Segments are the fundamental capacity intervals.

## Service / Departure

A `Service` (scheduled departure/trip instance) binds a route, vehicle, operator and departure timing. Actual operational timestamps may differ from scheduled timestamps.

## Vehicle

A vehicle has a capacity and belongs to or is managed by an operator. Capacity changes must be versioned/audited when they affect scheduled services.

## Booking

A booking references a service plus boarding and alighting RouteStops. Boarding ordinal must be strictly less than alighting ordinal.

A booking consumes quantity `q` on every segment within `[boardingOrdinal, alightingOrdinal)` while its state counts against capacity.

### Capacity invariant

For every segment occupied by a proposed booking:

`confirmed_or_held_quantity + proposed_quantity <= service_capacity`

The database/application transaction must protect this invariant under concurrent booking attempts.

## Manifest

The service manifest derives passengers/bookings relevant to the service and supports expected, boarded, no-show, transferred/recovered and alighted states.

## Fare

Fare calculation is server-side and may depend on operator, route, boarding/alighting points, passenger category, service class and configured rules. Client-submitted prices are never authoritative.

## Payment

Payments are separate from bookings. A booking can reference one or more payment attempts/transactions. Provider callbacks must be idempotent and auditable.

## Vehicle location

Location observations include service/vehicle identity, coordinates, observed time and source. Invalid/stale updates must not silently replace fresher accepted state.

## Incident

An incident belongs to a service/vehicle context and has a typed category, severity/status, location/time and audit history.

## Recovery

Recovery associates affected bookings/passengers with a resolution such as replacement service, replacement vehicle, refund/cancellation or another operational disposition. Original history remains preserved.
