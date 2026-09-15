# Operator & Crew Model

One canonical operator model backs every operational path in LeRoutier.

```
Operator
├── type = independent
│   └── owner may also be the Driver (same identity, same operator)
│
└── type = company
    ├── Operator Admin / Ops (unique personal logins)
    ├── Drivers
    ├── Convoyeurs
    ├── Vehicles
    ├── Operator Stations
    └── Services
```

There is no second business-account concept: a transport company onboards as
an **operator**, never as a driver account.

## Authorization chain

```
authenticated user (OIDC subject, DB-authoritative)
    ↓
operator membership (users.operator_id)
    ↓
operator (type, verification status, ownership)
    ↓
role + permissions (passenger | driver | convoyeur | ops)
```

Operator/role authority lives in the database — never in JWT claims. Every
staff member has a unique personal identity; shared company accounts do not
exist and cannot be created (provisioning binds one subject to one member).

## Onboarding

- **Passenger** — the default; no operator membership.
- **Independent Driver** — one identity becomes, in one idempotent
  transaction: owner of a `type=independent` operator, its admin, and its
  driver (`driver_profiles.user_id = operator.owner_user_id`). They are the
  revenue beneficiary and may withdraw the operator balance.
- **Transport Company** — one identity submits the company profile; an
  `type=company` operator is created and that identity becomes its admin Ops
  user. The company then provisions staff through the normal provisioning
  API (`/api/v1/ops/drivers|convoyeurs|ops-users`).

Verification states: `draft`, `pending_verification`, `verified`,
`rejected`, `suspended`. Onboarding always starts at `pending_verification`;
only platform Ops can transition verification. Unverified operators cannot
create services or withdraw funds — onboarding data is still editable.

## Convoyeur

A distinct crew role, never merged into Driver. A convoyeur is provisioned
by company admin, assigned to a service alongside the driver
(`service_assignments.convoyeur_id`), and may: scan tickets, sell walk-up
seats, collect cash, handle parcel consignment/scanning/custody and report
station issues. A convoyeur never drives and never sees another operator's
data.

## Revenue ownership (canonical)

Revenue belongs to the **operator**:

```
passenger payment / parcel payment → service → operator → operator settlement ledger
```

The settlement ledger (`operator_settlements`, integer minor units) is
credited only from trusted recorded activity (walk-up cash sales, cash parcel
collection) — no commission formula exists. Independent owner-drivers can
withdraw their own operator balance (`/api/v1/operator/payouts`, Ops-approved
like driver payouts). Company drivers, convoyeurs and admins can never
withdraw company revenue.

## Cash rule (canonical)

The Passenger app is online-payment only — the passenger API rejects cash.
Cash exists solely through the crew walk-up flow
(`POST /api/v1/driver/walk-up-bookings`, Driver or Convoyeur on the assigned
service): a guest passenger identity, a cash payment record matched against
the segment fare, confirmation, and an operator settlement credit. The
collecting crew member never owns the revenue; the independent owner-driver
is both collector and beneficiary of their own operator.
