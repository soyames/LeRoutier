-- Transparent passenger ticket pricing and provider subscription groundwork.
-- Additive and replay-safe: existing bookings and payment rows remain valid.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS fare_minor integer NOT NULL DEFAULT 0 CHECK (fare_minor >= 0);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_fee_minor integer NOT NULL DEFAULT 0 CHECK (service_fee_minor >= 0);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_fee_minor integer NOT NULL DEFAULT 0 CHECK (provider_fee_minor >= 0);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_fee_minor integer NOT NULL DEFAULT 0 CHECK (service_fee_minor >= 0);
ALTER TABLE booking_groups ADD COLUMN IF NOT EXISTS service_fee_minor integer NOT NULL DEFAULT 0 CHECK (service_fee_minor >= 0);

-- For historic payments, the full recorded amount was the fare under the old
-- pricing model. Do not rewrite those invoices as if a service fee was charged.
UPDATE payments SET fare_minor=amount_minor
  WHERE fare_minor=0 AND amount_minor>0 AND provider IN ('fedapay','cash','bank_transfer','demo');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('passenger','driver','ops','convoyeur','cashier'));
ALTER TABLE assistant_events DROP CONSTRAINT IF EXISTS assistant_events_role_check;
ALTER TABLE assistant_events ADD CONSTRAINT assistant_events_role_check
  CHECK (role IN ('anonymous','passenger','driver','convoyeur','cashier','ops'));

-- A company cashier is provisioned by company operations and is scoped by
-- users.operator_id. Independent owner-drivers do not need or get cashier
-- identities. Authorization of each sale also verifies service.operator_id.

ALTER TABLE operator_plans ADD COLUMN IF NOT EXISTS billing_period text NOT NULL DEFAULT 'month'
  CHECK (billing_period IN ('month','six_months','year'));
ALTER TABLE operator_plans ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz NOT NULL DEFAULT '2027-04-30T23:00:00Z';
ALTER TABLE operator_plans ADD COLUMN IF NOT EXISTS paid_through timestamptz;
ALTER TABLE operator_plans ADD COLUMN IF NOT EXISTS last_payment_reference text;
ALTER TABLE operator_plans ADD COLUMN IF NOT EXISTS selected_at timestamptz NOT NULL DEFAULT now();

UPDATE operator_plans p SET monthly_price_minor=CASE WHEN o.type='company' THEN 30000 ELSE 10000 END
FROM operators o WHERE p.operator_id=o.id AND p.effective_to IS NULL AND p.monthly_price_minor IS NULL;

DROP TRIGGER IF EXISTS no_independent_plan ON operator_plans;
DROP FUNCTION IF EXISTS independent_operator_has_no_plan();

-- Current operators receive the announced adoption period. A subscription is
-- not required until May 1, 2027; this row records provider choice without
-- attempting unsupported automatic recurring charges.
INSERT INTO operator_plans(operator_id,plan,monthly_price_minor,billing_status,billing_period,trial_ends_at)
SELECT o.id,'standard',CASE WHEN o.type='company' THEN 30000 ELSE 10000 END,
  'not_billed','month','2027-04-30T23:00:00Z'::timestamptz
FROM operators o WHERE NOT EXISTS (
  SELECT 1 FROM operator_plans p WHERE p.operator_id=o.id AND p.effective_to IS NULL
);

CREATE TABLE IF NOT EXISTS operator_cashier_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  user_id uuid NOT NULL REFERENCES users(id),
  assigned_by uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('assigned','revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operator_cashier_audit_user ON operator_cashier_audit(operator_id,user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS operator_subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  billing_period text NOT NULL CHECK (billing_period IN ('month','six_months','year')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  provider text NOT NULL CHECK (provider IN ('fedapay','mtn_momo','moov_momo','bank_transfer','cash')),
  reference text NOT NULL CHECK (char_length(reference) BETWEEN 2 AND 150),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  reviewed_by uuid REFERENCES users(id),
  paid_through timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE(provider,reference)
);
CREATE INDEX IF NOT EXISTS operator_subscription_payments_pending ON operator_subscription_payments(created_at)
  WHERE status='pending';
