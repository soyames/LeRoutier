-- Reconcile online operator fare, directly collected cash and partial refunds.
-- Additive and safe to replay.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_minor integer NOT NULL DEFAULT 0
  CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor);
UPDATE payments SET refunded_minor=amount_minor WHERE status='refunded' AND refunded_minor=0;

-- A walk-up fare is already in the operator's hands. Keep it visible in the
-- monthly CRM report, but never treat it as a second platform-held payout.
ALTER TABLE operator_settlements DROP CONSTRAINT IF EXISTS operator_settlements_payout_state_check;
ALTER TABLE operator_settlements ADD CONSTRAINT operator_settlements_payout_state_check
  CHECK (payout_state IN ('available','reserved','paid','reversed','direct'));
DO $$
DECLARE old_constraint text;
BEGIN
  SELECT c.conname INTO old_constraint
  FROM pg_constraint c
  WHERE c.conrelid='operator_settlements'::regclass AND c.contype='c'
    AND pg_get_constraintdef(c.oid) LIKE '%payout_request_id%'
    AND c.conname<>'operator_settlements_state_request_check'
  LIMIT 1;
  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE operator_settlements DROP CONSTRAINT %I',old_constraint);
  END IF;
END $$;
ALTER TABLE operator_settlements DROP CONSTRAINT IF EXISTS operator_settlements_state_request_check;
ALTER TABLE operator_settlements ADD CONSTRAINT operator_settlements_state_request_check
  CHECK ((payout_state IN ('available','direct')) = (payout_request_id IS NULL));
UPDATE operator_settlements SET payout_state='direct'
  WHERE source='walk_up' AND payout_state='available';

ALTER TABLE operator_payout_requests ADD COLUMN IF NOT EXISTS payout_kind text NOT NULL DEFAULT 'manual'
  CHECK (payout_kind IN ('manual','monthly'));
ALTER TABLE operator_payout_requests ADD COLUMN IF NOT EXISTS payout_period date;
ALTER TABLE operator_payout_requests ADD COLUMN IF NOT EXISTS debt_offset_minor integer NOT NULL DEFAULT 0
  CHECK (debt_offset_minor >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS operator_payout_period_once
  ON operator_payout_requests(operator_id,payout_period)
  WHERE payout_kind='monthly' AND payout_period IS NOT NULL;

CREATE TABLE IF NOT EXISTS operator_payout_schedules (
  operator_id uuid PRIMARY KEY REFERENCES operators(id),
  enabled boolean NOT NULL DEFAULT false,
  phone_number text NOT NULL CHECK (phone_number ~ '^[0-9]{8,15}$'),
  country char(2) NOT NULL DEFAULT 'BJ',
  network text,
  consented_by uuid NOT NULL REFERENCES users(id),
  consented_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operator_payout_schedules_enabled
  ON operator_payout_schedules(operator_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS operator_settlement_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  payment_id uuid NOT NULL REFERENCES payments(id),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  settled_minor integer NOT NULL DEFAULT 0 CHECK (settled_minor >= 0 AND settled_minor <= amount_minor),
  allocated_minor integer NOT NULL DEFAULT 0 CHECK (allocated_minor >= 0 AND allocated_minor <= amount_minor - settled_minor),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','allocated','settled')),
  payout_request_id uuid REFERENCES operator_payout_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE(payment_id),
  CHECK ((state='allocated') = (payout_request_id IS NOT NULL)),
  CHECK ((state='settled') = (settled_minor=amount_minor))
);
CREATE INDEX IF NOT EXISTS operator_settlement_reversals_open
  ON operator_settlement_reversals(operator_id,created_at) WHERE state='open';

CREATE TABLE IF NOT EXISTS operator_reversal_allocations (
  payout_request_id uuid NOT NULL REFERENCES operator_payout_requests(id),
  reversal_id uuid NOT NULL REFERENCES operator_settlement_reversals(id),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  state text NOT NULL DEFAULT 'allocated' CHECK (state IN ('allocated','settled','released','reversed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY(payout_request_id,reversal_id)
);
