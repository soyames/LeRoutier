# LeRoutier — Product Vision

## Purpose

LeRoutier is intended to make road passenger transport easier to discover, understand, book, operate and supervise. The first market is Benin, while the domain model should remain reusable for later geographic expansion.

## Actors

### Passenger
A passenger needs to find a viable journey between two places, understand where to board and leave, see availability and price, reserve/pay where applicable, receive operational updates and follow the trip.

### Driver
A driver needs a simple operational interface showing the trip, route/stops, expected passengers, boarding/alighting events, remaining capacity, incidents and instructions.

### Transport operator
An operator manages vehicles, drivers, services, routes, stops, schedules, capacity, fares and operational exceptions.

### LeRoutier operations
Platform operations manages geographic reference data, operator onboarding, service quality, disputes/incidents, payment reconciliation and platform-wide configuration.

## Core passenger journey

1. Passenger selects origin and destination.
2. System resolves those places against the transport network and stops/boarding points.
3. Search returns journeys whose ordered stop sequence can actually carry the passenger from origin to destination.
4. Availability is evaluated over every segment occupied by that passenger.
5. Passenger selects a service and boarding/alighting points.
6. Reservation temporarily or definitively consumes capacity according to booking state.
7. Payment is recorded through the configured payment channel where required.
8. Passenger receives booking/trip information and operational notifications.
9. During execution, vehicle progress and relevant ETA/status information are surfaced.
10. Boarding and alighting update the operational manifest and capacity state.

## Segment-aware capacity

A vehicle with 20 seats is not simply “full” or “available” for its entire route. If one passenger travels A → B, that seat can subsequently serve another passenger B → C. Availability therefore belongs to route segments and departures, not only to the vehicle.

A booking from stop i to stop j consumes one seat on every consecutive segment from i through j-1. A booking is accepted only when all those segments have sufficient capacity.

## Operational disruption and passenger recovery

Incidents must be explicit domain events rather than free-text notes only. Examples include breakdown, accident, severe delay, blocked road, vehicle replacement or trip cancellation.

When a trip cannot continue, operations must be able to identify affected passengers, their current/remaining journey segments and recovery status. A replacement vehicle/service can then be associated with affected bookings while preserving the audit trail.

## Driver community

Driver/community capabilities should support useful professional communication without replacing authoritative operational instructions. Community content and operational trip data must remain logically separated and permissioned.

## Accessibility and connectivity

LeRoutier should progressively support:

- installable PWAs;
- low-bandwidth screens;
- resilient/retryable actions;
- concise text notifications;
- audio-assisted alerts where useful;
- USSD for selected essential journeys/workflows where technically and commercially feasible.

## Geography

Administrative/geographic data must be modeled independently from transport stops. A department, commune, arrondissement, village or urban neighborhood is a geographic entity; a station, roadside pickup point or terminal is a transport stop. They may be linked but are not interchangeable.

## Out of scope for the foundation

The initial repository structure deliberately does not hard-code a specific payment provider, operator, fare table, administrative count, proprietary map vendor or single deployment vendor. Those decisions belong in configuration/integrations and must be validated before production use.
