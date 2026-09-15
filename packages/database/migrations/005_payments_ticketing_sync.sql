ALTER TABLE payments ALTER COLUMN provider_reference DROP NOT NULL;
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK(status IN ('pending','succeeded','failed','cancelled','refunded'));
ALTER TABLE payments ADD COLUMN checkout_url text;
ALTER TABLE payments ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE payments ADD COLUMN reconciliation text NOT NULL DEFAULT 'applied' CHECK(reconciliation IN ('pending','applied','review'));
CREATE UNIQUE INDEX one_pending_payment ON payments(booking_id) WHERE status='pending';
CREATE TABLE payment_events (
  provider text NOT NULL, event_id text NOT NULL, payment_id uuid NOT NULL REFERENCES payments(id),
  fingerprint text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,event_id)
);
CREATE TABLE ticket_credentials (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id), version integer NOT NULL CHECK(version>0),
  token_hash text NOT NULL UNIQUE, code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, issued_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE driver_action_receipts (
  actor_id uuid NOT NULL REFERENCES users(id), idempotency_key text NOT NULL,
  fingerprint text NOT NULL, service_id uuid NOT NULL REFERENCES services(id),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,idempotency_key)
);
