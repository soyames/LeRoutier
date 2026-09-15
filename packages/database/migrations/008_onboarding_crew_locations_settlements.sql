-- Onboarding & membership: operator types/ownership, crew roles, locations,
-- operator settlements. Checksummed/replay-safe like every migration before it.

-- Operators: one canonical model, differentiated by type. Company and
-- independent operators share every existing operator capability.
ALTER TABLE operators ADD COLUMN type text NOT NULL DEFAULT 'company' CHECK(type IN ('independent','company'));
ALTER TABLE operators ADD COLUMN owner_user_id uuid REFERENCES users(id);
ALTER TABLE operators ADD COLUMN admin_user_id uuid REFERENCES users(id);
ALTER TABLE operators ADD COLUMN verification_status text NOT NULL DEFAULT 'pending_verification'
  CHECK(verification_status IN ('draft','pending_verification','verified','rejected','suspended'));
ALTER TABLE operators ADD COLUMN contact_phone text;
ALTER TABLE operators ADD COLUMN country char(2) NOT NULL DEFAULT 'BJ';
ALTER TABLE operators ADD COLUMN registration_ref text;
ALTER TABLE operators ADD COLUMN payout_ready boolean NOT NULL DEFAULT false;
-- An independent operator is owned by exactly one user; companies have no owner.
ALTER TABLE operators ADD CONSTRAINT independent_ownership
  CHECK(type<>'independent' OR owner_user_id IS NOT NULL);

-- Convoyeurs: a distinct crew role, never merged into Driver.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('passenger','driver','ops','convoyeur'));
CREATE TABLE convoyeur_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  operator_id uuid NOT NULL REFERENCES operators(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Company services may carry a convoyeur alongside the driver.
ALTER TABLE service_assignments ADD COLUMN convoyeur_id uuid REFERENCES convoyeur_profiles(user_id);

-- Canonical operational location registry: one normalized model for company
-- stations, public bus parks, independent boarding points and parcel points.
-- A location supports multiple purposes and is moderated before it is trusted.
CREATE TABLE boarding_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  place_id uuid NOT NULL REFERENCES places(id),
  stop_id uuid REFERENCES stops(id),
  type text NOT NULL CHECK(type IN ('company_station','public_bus_park','independent_boarding_point','roadside_pickup','parcel_consignment_point','parcel_pickup_point')),
  description text,
  latitude double precision CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision CHECK(longitude BETWEEN -180 AND 180),
  purposes jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','verified','rejected')),
  proposed_by uuid NOT NULL REFERENCES users(id),
  verified_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boarding_points_search ON boarding_points(place_id,status);
-- One verified canonical entry per (name, place); proposals may exist beside it.
CREATE UNIQUE INDEX one_verified_point ON boarding_points(name,place_id) WHERE status='verified';

-- Operator affiliation to a physical location ("Baobab Express – Gare Bohicon").
CREATE TABLE operator_stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  boarding_point_id uuid NOT NULL REFERENCES boarding_points(id),
  name text NOT NULL,
  address text,
  latitude double precision CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision CHECK(longitude BETWEEN -180 AND 180),
  purposes jsonb NOT NULL DEFAULT '[]',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operator_id,boarding_point_id)
);
CREATE INDEX operator_stations_operator ON operator_stations(operator_id,active);

-- Operational precision: services board/depart and arrive at exact locations.
ALTER TABLE services ADD COLUMN departure_point_id uuid REFERENCES boarding_points(id);
ALTER TABLE services ADD COLUMN arrival_point_id uuid REFERENCES boarding_points(id);

-- Parcel flows reuse the same registry for consignment and pickup precision.
ALTER TABLE parcels ADD COLUMN consignment_point_id uuid REFERENCES boarding_points(id);
ALTER TABLE parcels ADD COLUMN pickup_point_id uuid REFERENCES boarding_points(id);

-- Operator revenue ledger: revenue belongs to the operator. Credits come from
-- walk-up cash bookings and parcel cash collection — never invented formulas.
CREATE TABLE operator_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  source text NOT NULL,
  reference text NOT NULL,
  gross_minor integer NOT NULL CHECK(gross_minor >= 0),
  deduction_minor integer NOT NULL DEFAULT 0 CHECK(deduction_minor >= 0 AND deduction_minor <= gross_minor),
  net_minor integer GENERATED ALWAYS AS (gross_minor - deduction_minor) STORED,
  currency char(3) NOT NULL DEFAULT 'XOF' CHECK(currency = 'XOF'),
  earned_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  payout_state text NOT NULL DEFAULT 'available' CHECK(payout_state IN ('available','reserved','paid','reversed')),
  payout_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(available_at >= earned_at),
  CHECK((payout_state = 'available') = (payout_request_id IS NULL))
);
CREATE INDEX operator_settlements_balance ON operator_settlements(operator_id,payout_state,available_at);

-- Withdrawals from operator revenue: independent owner-drivers withdraw their
-- own operator balance; company staff never can (authorization, not schema).
CREATE TABLE operator_payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  amount_minor integer NOT NULL CHECK(amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'XOF' CHECK(currency = 'XOF'),
  phone_number text NOT NULL,
  country char(2) NOT NULL DEFAULT 'BJ',
  network text,
  provider text NOT NULL DEFAULT 'fedapay',
  provider_reference text,
  provider_metadata jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','processing','paid','failed','cancelled','reversed')),
  idempotency_key text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  approved_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_reference)
);
CREATE INDEX operator_payout_requests_operator ON operator_payout_requests(operator_id,created_at DESC);

CREATE TABLE operator_payout_events (
  provider text NOT NULL, event_id text NOT NULL,
  payout_request_id uuid NOT NULL REFERENCES operator_payout_requests(id),
  fingerprint text NOT NULL, status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,event_id)
);

ALTER TABLE operator_settlements ADD CONSTRAINT settlements_payout_request
  FOREIGN KEY(payout_request_id) REFERENCES operator_payout_requests(id) DEFERRABLE INITIALLY DEFERRED;
