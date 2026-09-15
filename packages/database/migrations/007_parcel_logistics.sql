-- Parcel Logistics v1: a first-class parcel domain riding existing LeRoutier
-- transport services. Separate lifecycle, custody, tracking, labels, pickup
-- verification and accounting — passenger luggage stays out of this model.
-- All money in integer minor units; migrations remain checksummed/replay-safe.

-- Reference data for acceptance: configurable categories with a prohibited flag.
-- Additional legal/regulatory classifications stay out of code.
CREATE TABLE parcel_categories (
  name text PRIMARY KEY,
  label text NOT NULL,
  accepted boolean NOT NULL DEFAULT true,
  notes text NOT NULL DEFAULT ''
);
INSERT INTO parcel_categories(name,label) VALUES
  ('documents','Documents'),('food','Denrées alimentaires'),('electronics','Électronique'),
  ('fragile','Fragile'),('high_value','Valeur déclarée'),('other','Autre');

CREATE TABLE parcels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_number text NOT NULL UNIQUE,
  operator_id uuid NOT NULL REFERENCES operators(id),
  origin_stop_id uuid NOT NULL REFERENCES stops(id),
  destination_stop_id uuid NOT NULL REFERENCES stops(id),
  category text NOT NULL REFERENCES parcel_categories(name),
  quantity integer NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 100),
  weight_g integer CHECK(weight_g IS NULL OR (weight_g BETWEEN 1 AND 500000)),
  dimensions jsonb,
  declared_value_minor integer CHECK(declared_value_minor IS NULL OR declared_value_minor >= 0),
  notes text,
  payment_responsibility text NOT NULL DEFAULT 'sender' CHECK(payment_responsibility IN ('sender','receiver','cash')),
  price_minor integer NOT NULL CHECK(price_minor >= 0),
  status text NOT NULL DEFAULT 'created' CHECK(status IN ('created','accepted','manifested','loaded','in_transit','arrived',
    'ready_for_pickup','collected','cancelled','rejected','held','damaged','lost','return_requested','returned')),
  eta_at timestamptz,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(created_by,idempotency_key)
);
CREATE INDEX parcels_status ON parcels(status,created_at);
CREATE INDEX parcels_operator ON parcels(operator_id,created_at DESC);

-- Sender/receiver details live behind authorization; public tracking never
-- exposes them.
CREATE TABLE parcel_parties (
  parcel_id uuid NOT NULL REFERENCES parcels(id),
  role text NOT NULL CHECK(role IN ('sender','receiver')),
  name text NOT NULL,
  phone text NOT NULL,
  PRIMARY KEY(parcel_id,role)
);

-- Secure label tokens, same pattern as passenger tickets: only digests stored.
-- The public barcode value is the tracking number itself.
CREATE TABLE parcel_labels (
  parcel_id uuid PRIMARY KEY REFERENCES parcels(id),
  version integer NOT NULL CHECK(version > 0),
  token_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now()
);

-- Chain of custody: one current holder per parcel, validated against the
-- lifecycle state machine; the full history lives in parcel_events.
CREATE TABLE parcel_custody (
  parcel_id uuid PRIMARY KEY REFERENCES parcels(id),
  holder_kind text NOT NULL CHECK(holder_kind IN ('station','driver','receiver')),
  operator_id uuid REFERENCES operators(id),
  driver_id uuid REFERENCES driver_profiles(user_id),
  service_id uuid REFERENCES services(id),
  stop_id uuid REFERENCES stops(id),
  since timestamptz NOT NULL DEFAULT now(),
  CHECK((holder_kind = 'driver') = (driver_id IS NOT NULL AND service_id IS NOT NULL))
);

CREATE TABLE parcel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id uuid NOT NULL REFERENCES parcels(id),
  kind text NOT NULL,
  actor_id uuid REFERENCES users(id),
  actor_role text,
  principal_id uuid REFERENCES agent_principals(id),
  operator_id uuid REFERENCES operators(id),
  service_id uuid REFERENCES services(id),
  vehicle_id uuid REFERENCES vehicles(id),
  stop_id uuid REFERENCES stops(id),
  note text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parcel_events_parcel ON parcel_events(parcel_id,created_at);
-- Offline scan replays can never duplicate a custody event.
CREATE UNIQUE INDEX parcel_scan_idempotent ON parcel_events(parcel_id,kind,idempotency_key) WHERE idempotency_key IS NOT NULL;

-- One row per service leg: v1 uses a single leg; multi-leg transport adds
-- sequential rows without schema changes.
CREATE TABLE parcel_service_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id uuid NOT NULL REFERENCES parcels(id),
  service_id uuid NOT NULL REFERENCES services(id),
  vehicle_id uuid REFERENCES vehicles(id),
  driver_id uuid REFERENCES driver_profiles(user_id),
  from_stop_id uuid NOT NULL REFERENCES stops(id),
  to_stop_id uuid NOT NULL REFERENCES stops(id),
  status text NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','loaded','in_transit','arrived','offloaded','cancelled')),
  assigned_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX parcel_assignments_service ON parcel_service_assignments(service_id,status);
CREATE UNIQUE INDEX one_active_parcel_assignment ON parcel_service_assignments(parcel_id) WHERE status IN ('assigned','loaded','in_transit','arrived');

-- Parcel accounting is deliberately separate from passenger fares: parcels
-- never mix into booking payment records, and no commission formula exists.
CREATE TABLE parcel_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id uuid NOT NULL REFERENCES parcels(id),
  provider text NOT NULL,
  provider_reference text,
  amount_minor integer NOT NULL CHECK(amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'XOF' CHECK(currency = 'XOF'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed','cancelled','refunded')),
  responsibility text NOT NULL CHECK(responsibility IN ('sender','receiver','cash')),
  idempotency_key text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_reference)
);
CREATE INDEX parcel_payments_parcel ON parcel_payments(parcel_id);

-- Single-use, expiring, hashed pickup codes: plaintext is returned exactly
-- once at issuance and never stored or logged.
CREATE TABLE parcel_pickup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id uuid NOT NULL REFERENCES parcels(id),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_pickup_code ON parcel_pickup_codes(parcel_id) WHERE used_at IS NULL;

-- Proof of delivery/collection: file references only (no blobs in PostgreSQL).
-- Photo/signature storage integration stays explicitly pending.
CREATE TABLE parcel_proof_of_delivery (
  parcel_id uuid PRIMARY KEY REFERENCES parcels(id),
  receiver_name text,
  collected_at timestamptz NOT NULL,
  stop_id uuid REFERENCES stops(id),
  released_by uuid REFERENCES users(id),
  signature_ref text,
  image_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE parcel_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id uuid NOT NULL REFERENCES parcels(id),
  kind text NOT NULL CHECK(kind IN ('damaged','lost','rejected','held','return_requested','other')),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  reported_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parcel_exceptions_open ON parcel_exceptions(parcel_id,status);

-- Pricing: explicit operator-configured rules only. If no rule matches, parcel
-- creation and quoting fail closed — production never invents prices.
CREATE TABLE parcel_rate_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  origin_stop_id uuid REFERENCES stops(id),
  destination_stop_id uuid REFERENCES stops(id),
  category text REFERENCES parcel_categories(name),
  min_weight_g integer,
  max_weight_g integer,
  base_minor integer NOT NULL CHECK(base_minor >= 0),
  per_kg_minor integer NOT NULL DEFAULT 0 CHECK(per_kg_minor >= 0),
  declared_value_bp integer NOT NULL DEFAULT 0 CHECK(declared_value_bp >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(min_weight_g IS NULL OR max_weight_g IS NULL OR min_weight_g <= max_weight_g)
);
CREATE INDEX parcel_rate_rules_lookup ON parcel_rate_rules(operator_id,origin_stop_id,destination_stop_id,category);
