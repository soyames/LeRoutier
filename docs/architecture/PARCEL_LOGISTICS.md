# Parcel Logistics v1

Intercity parcel transport digitized as a first-class LeRoutier workstream:
parcels ride the **existing passenger transport services and vehicles** — no
separate courier network, no separate app, no separate backend.

## Domain model

- `parcels` — shipment root: human-friendly unique tracking number
  (`LRP-XXXXXXXX`), operator, origin/destination stops, category, quantity,
  optional weight (grams) / dimensions / declared value (integer minor units),
  payment responsibility (`sender` | `receiver` | `cash`), explicit price and
  lifecycle status. Creation is idempotency-keyed.
- `parcel_parties` — sender and receiver names + phones, stored behind
  authorization; **public tracking never exposes them**.
- `parcel_labels` — secure QR tokens (`LRP1.…`), only SHA-256 digests stored,
  rotation bumps a version (same pattern as passenger tickets). The barcode
  value is the tracking number itself (safe to share).
- `parcel_events` — append-only custody/status history; scans are idempotent
  via `(parcel_id, kind, idempotency_key)`.
- `parcel_custody` — one current holder per parcel
  (`station` → `driver` → `station` → `receiver`), validated against the
  state machine.
- `parcel_service_assignments` — one row per service leg. v1 uses a single
  leg; multi-leg transport adds sequential rows without schema changes.
- `parcel_payments` — separate accounting from passenger fares. Cash/station
  records must match the parcel price; FedaPay collection can slot into the
  same provider abstraction later. No commission formula exists.
- `parcel_pickup_codes` — single-use, 15-minute, hashed codes; plaintext is
  returned exactly once at issuance.
- `parcel_proof_of_delivery` — receiver name, station, releasing actor,
  signature/image **references only** (no blobs in PostgreSQL; storage
  integration pending).
- `parcel_exceptions` — damaged / lost / rejected / held / return_requested
  / other, each driving a lifecycle transition.
- `parcel_rate_rules` — explicit operator-configured pricing. **No rule → no
  quote, no creation: production never invents prices.**
- `parcel_categories` — acceptance reference data with a generic
  `accepted` flag; legal/regulatory classifications stay out of code.

## Lifecycle

```
created → accepted → manifested → loaded → in_transit → arrived
  → ready_for_pickup → collected
```

Exception/terminal states: `cancelled`, `rejected`, `held`, `damaged`,
`lost`, `return_requested`, `returned`. Every transition is validated
server-side (`packages/database/src/parcels.js`); impossible or duplicated
custody transitions are rejected.

## Chain of custody

- accepted → station custody at the origin stop;
- loaded → driver custody with the assigned service/vehicle;
- arrived → station custody at the destination stop;
- collected → receiver custody (with a validated pickup code);
- held/rejected/cancelled → custody returns to station or is closed.

Every custody transition records parcel, actor, actor role, operator,
service/vehicle and stop where applicable, with a timestamp and optional
note — full history in `parcel_events`, current holder in `parcel_custody`.

## Tracking, barcode & QR

- Public tracking: `GET /api/v1/public/parcel-tracking/:trackingNumber`
  (rate-limited, no authentication). Returns only safe fields: tracking
  number, status, origin/destination cities, last milestone, ETA, pickup
  readiness and — while loaded/in-transit — the latest trusted vehicle
  position, explicitly labeled `derivedFromVehicle: true` (vehicle-derived,
  never parcel-level GPS).
- QR identifies the parcel token; the barcode is the tracking number.
  Neither embeds personal data.

## Pickup verification

1. Ops marks the parcel `ready_for_pickup` and issues a code
   (`POST /api/v1/parcels/{id}/pickup-code`): hashed, 15-minute expiry,
   single-use, previous active codes superseded.
2. The receiver presents the code; the station (or the assigned driver at
   destination) collects with `POST /api/v1/parcels/{id}/pickup`.
3. Only server validation marks the parcel `collected`; invalid, expired or
   reused codes are rejected; a proof-of-delivery record is written.

## API (all under `/api/v1`)

`GET /parcels/quote`, `POST /parcels`, `GET /me/parcels`, `GET /parcels/{id}`,
`GET /parcels/{id}/events`, `GET /parcels/{id}/label`,
`POST /parcels/{id}/accept|assign|scan|ready|pickup-code|pickup|exceptions|cancel|payments`,
`GET /public/parcel-tracking/:trackingNumber`, `GET /ops/parcels`,
`GET|POST /ops/parcel-rate-rules`, `GET /driver/parcels`.
No unversioned parcel endpoints exist; legacy aliases keep calling shared
handlers per the versioning policy (`API_VERSIONING.md`).

## Agentic workflows

Parcel actions run through the same scoped principals and approval gates as
the rest of the platform (`parcel.read`, `parcel.manage`, `parcel.notify`
scopes; operator boundaries enforced). Examples:

- **parcel-delay** (`service.position` → open delay incident): detect parcels
  on the service → record `parcel.delayed` events → Ops alert.
- **parcel-breakdown** (`incident.created`): detect parcels on the affected
  service → propose a replacement → **Ops approval** → reassign (custody
  transfer recorded) → notify receiver → Ops alert.
- Typed actions: `parcel.inspect`, `parcel.delayed_inspect`,
  `parcel.uncollected`, `parcel.eta_update`, `parcel.delay_notice`,
  `parcel.notify`, `parcel.escalate`, `parcel.reassign` (approval),
  `parcel.reconcile_payment` (financial, approval), `parcel.exception_report`.

## Offline behavior

Driver parcel scans (loaded/arrived) flow through the same offline queue as
boarding actions: pending until synced, replay-safe via server idempotency.
Offline replays can never duplicate a custody event or overwrite newer
custody truth — scans are validated against current server state on sync.
Parcel damage reports are online-only for v1.

## Payments & pricing

- `paymentResponsibility` records who pays; station cash collection is an
  Ops-privileged, audited action that must match the configured price.
- Rate rules: origin/destination, category, weight band, base + per-kg +
  declared-value basis points; most specific rule wins.
- FedaPay collection for parcels can reuse the existing provider adapter
  without schema changes; it is intentionally not wired until product
  decides to enable it.

## Future evolution (designed for, not implemented)

Multi-leg transport (sequential assignment rows), station hubs and
warehouses, external carriers and DHL/DPD-style integrations, merchant
fulfillment, last-mile couriers, home delivery, lockers, returns, partner
API access — none of today's model blocks them.
