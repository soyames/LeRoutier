-- Apply and validate before deploying the corresponding API/web build.
CREATE TABLE operator_subscriptions (
  operator_id uuid PRIMARY KEY REFERENCES operators(id),
  billing_period text NOT NULL CHECK(billing_period IN ('monthly','halfYear','yearly')),
  billing_contact jsonb NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  paid_until timestamptz,
  CHECK(paid_until IS NULL OR paid_until >= '2027-05-01 00:00:00+01')
);
CREATE TABLE subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  billing_period text NOT NULL CHECK(billing_period IN ('monthly','halfYear','yearly')),
  billing_contact jsonb NOT NULL,
  amount_minor integer NOT NULL CHECK(amount_minor > 0),
  provider_fee_minor integer NOT NULL DEFAULT 0 CHECK(provider_fee_minor >= 0),
  currency text NOT NULL DEFAULT 'XOF' CHECK(currency='XOF'),
  provider text NOT NULL,
  provider_reference text,
  provider_metadata jsonb NOT NULL DEFAULT '{}',
  checkout_url text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed','cancelled','refunded')),
  idempotency_key text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now() CHECK(created_at >= '2027-05-01 00:00:00+01'),
  verified_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  UNIQUE(provider,provider_reference)
);
CREATE UNIQUE INDEX one_pending_subscription_payment ON subscription_payments(operator_id) WHERE status='pending';
CREATE TABLE operator_cash_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id),
  fare_minor integer NOT NULL CHECK(fare_minor > 0),
  fee_minor integer NOT NULL CHECK(fee_minor >= 0),
  cash_received_minor integer NOT NULL CHECK(cash_received_minor = fare_minor + fee_minor),
  collected_minor integer NOT NULL DEFAULT 0 CHECK(collected_minor >= 0 AND collected_minor <= fee_minor),
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operator_cash_fee_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_fee_id uuid NOT NULL REFERENCES operator_cash_fees(id),
  amount_minor integer NOT NULL CHECK(amount_minor > 0),
  reference text NOT NULL UNIQUE,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payments ADD COLUMN operator_refunded_minor integer NOT NULL DEFAULT 0 CHECK(operator_refunded_minor >= 0);
ALTER TABLE operator_payout_schedules ADD COLUMN consent_version text NOT NULL DEFAULT 'legacy';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_refunded_minor_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_refund_amount_check;
ALTER TABLE payments ADD CONSTRAINT payments_refund_amount_check CHECK(refunded_minor >= 0 AND refunded_minor <= amount_minor+provider_fee_minor);
-- Existing verified refunds must not be charged back to the operator twice.
UPDATE payments SET operator_refunded_minor=LEAST(refunded_minor,CASE WHEN fare_minor>0 THEN fare_minor ELSE amount_minor END)
  WHERE status='refunded';
-- Cash fares already belong to the operator; historic unsent cash is direct.
UPDATE operator_settlements SET payout_state='direct' WHERE source='parcel_cash' AND payout_state='available';
-- Historic real walk-up payments also owe the recorded 2% platform fee.
INSERT INTO operator_cash_fees(operator_id,booking_id,fare_minor,fee_minor,cash_received_minor,recorded_by,created_at)
SELECT s.operator_id,b.id,p.fare_minor,p.service_fee_minor,p.amount_minor,p.recorded_by,p.created_at
FROM bookings b JOIN services s ON s.id=b.service_id
JOIN payments p ON p.booking_id=b.id AND p.provider='cash' AND p.status='succeeded'
WHERE NOT s.is_demo AND p.recorded_by IS NOT NULL AND p.fare_minor>0 AND p.amount_minor=p.fare_minor+p.service_fee_minor
ON CONFLICT(booking_id) DO NOTHING;
