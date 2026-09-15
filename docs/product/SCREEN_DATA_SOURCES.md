# Screen Data Sources

Every screen's real data source. Any future UI code introducing hard-coded
business data (operators, routes, stops, services, vehicles, passengers,
prices, ETA, occupancy) violates this contract — use the endpoint or render
an honest empty state.

## Passenger app

| Screen | API (`/api/v1`) | Domain service | DB entities |
| --- | --- | --- | --- |
| Trips search | `GET /routes`, `GET /services?originStopId&destinationStopId` | transport, provisioning catalog | routes, route_stops, services, service_stops, boarding_points, service_assignments |
| Booking | `POST /bookings` | transport.txHold | bookings, booking_segments, service_seats |
| Tickets list | `GET /me/bookings` | transport.passengerBookings | bookings, services, routes, boarding_points, places |
| Payment | `POST /bookings/{id}/payment-intents`, `GET /bookings/{id}/payment-status`, `GET /payments/config` | payments + FedaPay adapter | payments, payment_events |
| Ticket QR | `POST /bookings/{id}/ticket` | tickets | ticket_credentials, services, boarding_points |
| Tracking | `GET /services/{id}/positions` | app route | vehicle_positions |
| Parcels | `GET /me/parcels`, `POST /parcels`, `GET /parcels/quote`, `GET /public/parcel-tracking/{n}`, `GET /parcels/{id}/label` | parcels | parcels, parcel_parties, parcel_labels, parcel_rate_rules |
| Onboarding | `POST /onboarding/company`, `POST /onboarding/independent`, `GET /onboarding/me` | onboarding | operators, users, driver_profiles, vehicles |

## Driver/Crew app

| Screen | API | Domain service | DB entities |
| --- | --- | --- | --- |
| Today | `GET /driver/service`, `GET /services/{id}/manifest`, `POST /services/{id}/advance|positions`, `POST /incidents` | transport | services, service_assignments, manifests, vehicle_positions, incidents |
| Manifest | `GET /services/{id}/manifest`, `POST /driver/actions` | transport, driver-actions | manifests, bookings, boarding_events, driver_action_receipts |
| Scanner | `POST /tickets/verify`, `POST /driver/actions` | tickets, driver-actions | ticket_credentials, bookings |
| Walk-up | `POST /driver/walk-up-bookings` | walkup | bookings, payments, users, operator_settlements |
| Parcels | `GET /driver/parcels`, `POST /parcels/{id}/scan|exceptions` | parcels | parcels, parcel_service_assignments, parcel_custody, parcel_events |
| Points | `GET /boarding-points`, `POST /boarding-points/proposals` | locations | boarding_points, places, stops |
| Earnings | `GET /driver/earnings`, `GET /operator/settlements`, `GET/POST /driver/payouts`, `GET/POST /operator/payouts` | payouts, operator-settlements | driver_earnings, payout_requests, operator_settlements, operator_payout_requests |
| Profile | session identity (`/me`) | identities | users, driver_profiles, convoyeur_profiles, operators |

## Ops app

| Screen | API | Domain service | DB entities |
| --- | --- | --- | --- |
| Today | `GET /ops/diagnostics`, `GET /ops/fleet`, `GET /agent/approvals`, `GET /operators`, `GET /ops/provisioning`, `GET /operators/{id}/stations` | app routes, onboarding, locations | counts over payments/payouts/incidents/workflow_runs/parcels, operators |
| Services | `GET /ops/fleet`, `POST /services/{id}/status`, `GET /incidents`, `PATCH /incidents/{id}` | transport, recovery | services, service_assignments, incidents |
| Fleet | `GET /ops/fleet`, `POST /ops/vehicles` | provisioning | vehicles |
| Crew | `GET /operators/{id}/members`, `POST /ops/drivers|convoyeurs|ops-users`, `GET /ops/provisioning` | provisioning, onboarding | users, driver_profiles, convoyeur_profiles |
| Stations | `GET /boarding-points`, `GET/POST /operators/{id}/stations`, `POST /boarding-points/{id}/moderate` | locations | boarding_points, operator_stations, places |
| Parcels | `GET /ops/parcels`, `POST /parcels/{id}/*`, `GET/POST /ops/parcel-rate-rules` | parcels | parcels, parcel_rate_rules |
| Payments | `GET /ops/payments`, `GET /ops/bookings`, `POST /bookings/{id}/payments`, `GET /ops/payouts`, `POST /ops/payouts/{id}/*` | payments, payouts, transport | payments, bookings, payout_requests |
| Settlements | `GET /ops/operator-payouts`, `POST /ops/operator-payouts/{id}/*` | operator-settlements | operator_payout_requests, operator_settlements |
| Incidents | `GET /incidents`, `PATCH /incidents/{id}` | app routes | incidents |
| Alerts | `GET /agent/approvals`, `POST /agent/approvals/{id}`, `GET /ops/diagnostics`, `POST /workflows/{id}/retry` | workflows engine | workflow_approvals, workflow_runs |
| Settings | `GET /ops/provisioning`, `POST /ops/*` | provisioning | operators, users, vehicles, routes, stops, places, services |
