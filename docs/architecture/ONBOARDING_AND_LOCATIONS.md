# Onboarding & Locations

## Location hierarchy

```
Place (city/locality)
  ↓
Stop (shared geographic transport area)
  ↓
Boarding Point (canonical operational location registry)
     ├── type: company_station | public_bus_park | independent_boarding_point
     │         | roadside_pickup | parcel_consignment_point | parcel_pickup_point
     ├── purposes: passenger_boarding | passenger_alighting | parcel_consignment | parcel_pickup
     └── status: proposed → verified | rejected
```

One normalized registry (`boarding_points`) serves every location need:
company stations are an **affiliation** (`operator_stations`) of an operator
to a verified point — "Baobab Express – Gare Bohicon" is a station row
pointing at one canonical physical location. No parallel location systems,
no parcel-only text fields.

- Independent drivers pick existing verified boarding points or **propose**
  a missing one; proposals are moderated by platform Ops before they become
  trusted canonical infrastructure. Duplicate names in the same place are
  rejected at proposal time.
- Company admins create stations from verified points with
  boarding/alighting/parcel purposes.

## Precision on tickets and parcels

- Services may reference an exact `departure_point_id` / `arrival_point_id`
  (verified points). Passenger tickets and booking views then state the
  exact boarding and arrival locations with landmark and coordinates —
  never only "Cotonou → Bohicon".
- Parcels reference `consignment_point_id` / `pickup_point_id` from the
  same registry; custody events keep their stop references and public
  tracking shows the point name and city (safe fields only).

## API surface (all under `/api/v1`)

| Route | Purpose |
| --- | --- |
| `GET /onboarding/me` | Current identity's role/membership state |
| `POST /onboarding/company` | Company onboarding (admin Ops identity) |
| `POST /onboarding/independent` | Independent owner-driver onboarding |
| `PATCH /onboarding/operator` | Owner/admin profile updates |
| `GET /operators` | Platform Ops operator list |
| `POST /operators/{id}/verification` | Platform verification transition |
| `GET /operators/{id}/members` | Membership list (admin/platform) |
| `GET /operators/{id}/stations`, `POST …` | Operator stations |
| `GET /boarding-points` | Registry search (place, purposes, proposals) |
| `POST /boarding-points/proposals` | Propose a missing point |
| `POST /boarding-points/{id}/moderate` | Platform approve/reject |
| `GET /services/{id}/crew` | Driver + convoyeur + vehicle of a service |
| `POST /driver/walk-up-bookings` | Crew cash sale (the only cash channel) |
| `GET /operator/settlements` | Operator revenue summary + ledger |
| `GET/POST /operator/payouts`, `…/cancel` | Owner withdrawals |
| `GET /ops/operator-payouts`, `…/approve`, `…/reconcile` | Ops payout controls |

## Agentic integration

Read-only actions respect the same state: `operator.unverified_detect`,
`operator.membership_drift`, `service.missing_point_detect`,
`location.moderation_backlog`, `location.nearest_recommend`. Mutations
(verification, station creation, moderation, withdrawals) always go through
the versioned API with normal authorization — agents have no DB bypass.

## Verification gating

Unverified operators cannot create services (`OPERATOR_NOT_VERIFIED`) or
withdraw settlements. Verification transitions are platform-only, audited
(`operator.verification_changed`) and emitted to the outbox
(`operator.verification_changed`).
