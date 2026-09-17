-- Fare Intelligence & commercial model.
--
-- Additive only: no production row is changed or deleted. History is append:
-- every published fare, completed platform transaction and recorded public
-- observation becomes its own row, and a price change never overwrites the
-- previous one. Segment-level OD pairs (Cotonou→Bohicon is distinct from
-- Cotonou→Parakou) keep intelligence aligned with the route-segment model.
--
-- Money stays integer minor units (FCFA has no minor unit; 1 FCFA = 1 minor).

-- One observation per publication, transaction or recorded public fare.
-- operator_id is NULL for external public observations: third-party evidence
-- is never mixed into a LeRoutier operator's own history.
CREATE TABLE fare_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid REFERENCES operators(id),
  origin_stop_id uuid NOT NULL REFERENCES stops(id),
  destination_stop_id uuid NOT NULL REFERENCES stops(id),
  route_id uuid REFERENCES routes(id),
  segment_sequence integer CHECK(segment_sequence IS NULL OR segment_sequence >= 0),
  fare_type text NOT NULL CHECK(fare_type IN ('passenger','parcel_standard','parcel_express')),
  price_minor integer NOT NULL CHECK(price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'XOF' CHECK(currency = 'XOF'),
  operator_type text CHECK(operator_type IN ('company','independent')),
  source_type text NOT NULL CHECK(source_type IN ('leroutier_published','leroutier_transaction','external_public')),
  source_reference text,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK(origin_stop_id <> destination_stop_id),
  CHECK(effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX fare_obs_lookup ON fare_observations(origin_stop_id,destination_stop_id,fare_type,effective_from);
CREATE INDEX fare_obs_operator ON fare_observations(operator_id,recorded_at DESC);
CREATE INDEX fare_obs_current ON fare_observations(operator_id,origin_stop_id,destination_stop_id,fare_type)
  WHERE effective_to IS NULL;
-- A source reference (payment id, route segment, external URL) records at most
-- one observation: duplicate events must not duplicate market evidence.
CREATE UNIQUE INDEX fare_obs_source_once ON fare_observations(operator_id,source_type,source_reference)
  WHERE source_reference IS NOT NULL AND operator_id IS NOT NULL;

-- Company SaaS plans are represented here; billing is never activated by this
-- migration. monthly_price_minor stays NULL until business pricing is decided
-- by the owner — no permanent FCFA subscription amount is invented.
CREATE TABLE operator_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  plan text NOT NULL DEFAULT 'standard',
  monthly_price_minor integer CHECK(monthly_price_minor IS NULL OR monthly_price_minor > 0),
  billing_status text NOT NULL DEFAULT 'not_billed' CHECK(billing_status IN ('not_billed','billing_pending')),
  included_features jsonb NOT NULL DEFAULT '[]',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz
);
CREATE UNIQUE INDEX operator_plan_current ON operator_plans(operator_id) WHERE effective_to IS NULL;
-- Policy: independent owner-drivers currently have no subscription at all.
-- The schema enforces what the business rule says, not a default row.
CREATE FUNCTION independent_operator_has_no_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM operators WHERE id=NEW.operator_id AND type='independent') THEN
    RAISE EXCEPTION 'Independent drivers have no subscription plan' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER no_independent_plan BEFORE INSERT OR UPDATE ON operator_plans
  FOR EACH ROW EXECUTE FUNCTION independent_operator_has_no_plan();

-- Parcel service levels: standard and express. Express means same-day delivery
-- as operated by the operator's own schedule; eligibility is checked at quote
-- and creation time, never promised blindly.
ALTER TABLE parcel_rate_rules ADD COLUMN service_level text NOT NULL DEFAULT 'standard'
  CHECK(service_level IN ('standard','express'));
ALTER TABLE parcels ADD COLUMN service_level text NOT NULL DEFAULT 'standard'
  CHECK(service_level IN ('standard','express'));
-- One active rule per service level and scope (NULLS NOT DISTINCT: a generic
-- rule and an OD-specific rule for the same level may coexist).
CREATE UNIQUE INDEX parcel_rules_level_once ON parcel_rate_rules
  (operator_id,service_level,origin_stop_id,destination_stop_id,category) NULLS NOT DISTINCT WHERE active;

-- The commission is the settlement deduction for platform transactions.
-- (operator, source, reference) is unique so a replayed provider event can
-- never credit the same operator twice; payout split rows carry a request-
-- scoped reference suffix and never collide with their originals.
CREATE UNIQUE INDEX settlements_reference_once ON operator_settlements(operator_id,source,reference);
