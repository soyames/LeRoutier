-- FedaPay collections, driver earnings ledger, payouts, agentic layer.
-- All money in integer minor units. Migration files are checksummed and replay-safe.

-- Provider-specific metadata attached to a payment (e.g. FedaPay transaction id).
ALTER TABLE payments ADD COLUMN provider_metadata jsonb NOT NULL DEFAULT '{}';

-- Driver earnings ledger. Earnings are credited only through the explicit
-- domain interface (packages/database/src/earnings.js); the commission/driver
-- revenue split is intentionally NOT derived here until product economics are
-- configured. Deductions must never exceed gross; net is derived.
CREATE TABLE driver_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES driver_profiles(user_id),
  operator_id uuid REFERENCES operators(id),
  source text NOT NULL,
  reference text NOT NULL,
  gross_minor integer NOT NULL CHECK(gross_minor >= 0),
  deduction_minor integer NOT NULL DEFAULT 0 CHECK(deduction_minor >= 0 AND deduction_minor <= gross_minor),
  net_minor integer GENERATED ALWAYS AS (gross_minor - deduction_minor) STORED,
  currency char(3) NOT NULL DEFAULT 'XOF' CHECK(currency = 'XOF'),
  earned_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL CHECK(available_at >= earned_at),
  payout_state text NOT NULL DEFAULT 'available' CHECK(payout_state IN ('available','reserved','paid','reversed')),
  payout_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Available rows must not be attached to a payout request; reserved/paid/reversed rows must.
  CHECK((payout_state = 'available') = (payout_request_id IS NULL))
);
CREATE INDEX driver_earnings_balance ON driver_earnings(driver_id,payout_state,available_at);
CREATE INDEX driver_earnings_ledger ON driver_earnings(driver_id,earned_at DESC);

-- Driver payout destinations. Minimal sensitive data: phone, country, optional
-- network. Prefer provider-side beneficiary references when the provider supports them.
CREATE TABLE payout_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES driver_profiles(user_id),
  country char(2) NOT NULL DEFAULT 'BJ',
  network text,
  phone_number text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  provider_beneficiary_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(driver_id,phone_number)
);

-- Payout withdrawal requests. The reserved earnings rows reference the request.
CREATE TABLE payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES driver_profiles(user_id),
  destination_id uuid NOT NULL REFERENCES payout_destinations(id),
  amount_minor integer NOT NULL CHECK(amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'XOF' CHECK(currency = 'XOF'),
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
CREATE INDEX payout_requests_driver ON payout_requests(driver_id,created_at DESC);
-- Reserved/paid/reversed earnings rows reference their payout request; available rows must not.
ALTER TABLE driver_earnings ADD CONSTRAINT earnings_payout_request
  FOREIGN KEY(payout_request_id) REFERENCES payout_requests(id) DEFERRABLE INITIALLY DEFERRED;

-- Deduplication of provider payout events (same pattern as payment_events).
CREATE TABLE payout_events (
  provider text NOT NULL, event_id text NOT NULL,
  payout_request_id uuid NOT NULL REFERENCES payout_requests(id),
  fingerprint text NOT NULL, status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,event_id)
);

-- Service/agent principals are deliberately distinct from human users.
-- operator_id is optional: set it to scope a principal to one operator;
-- platform-scoped principals (null) are documented and audited.
CREATE TABLE agent_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  operator_id uuid REFERENCES operators(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_scopes (
  principal_id uuid NOT NULL REFERENCES agent_principals(id),
  scope text NOT NULL,
  PRIMARY KEY(principal_id,scope)
);

-- Lightweight workflow runs and human-approval gates for agentic operations.
CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow text NOT NULL,
  trigger_event text NOT NULL,
  aggregate_id uuid NOT NULL,
  principal_id uuid REFERENCES agent_principals(id),
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','awaiting_approval','completed','failed','cancelled')),
  context jsonb NOT NULL DEFAULT '{}',
  step text NOT NULL DEFAULT 'start',
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_runs_status ON workflow_runs(status,created_at);
CREATE UNIQUE INDEX one_open_workflow_run ON workflow_runs(workflow,aggregate_id,trigger_event)
  WHERE status IN ('running','awaiting_approval');

CREATE TABLE workflow_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  action text NOT NULL,
  rationale text NOT NULL,
  proposed jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_pending_workflow_approval ON workflow_approvals(workflow_run_id,action) WHERE status='pending';

-- Audit events may be written by agent principals as well as human users.
ALTER TABLE audit_events ADD COLUMN principal_id uuid REFERENCES agent_principals(id);

-- Idempotency receipts for agent actions (same pattern as provisioning_requests).
CREATE TABLE agent_action_receipts (
  principal_id uuid NOT NULL REFERENCES agent_principals(id),
  action text NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  workflow_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(principal_id,action,idempotency_key)
);
