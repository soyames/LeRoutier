-- USSD as a channel: short-lived session state and replay protection.
--
-- Two tables and nothing else. USSD adds no booking, capacity, payment or
-- parcel state of its own — those stay where they already are, and this schema
-- would be wrong if it grew a copy of any of them.
--
-- What is deliberately NOT stored: the phone number, the provider's raw
-- payload, and anything a later screen could re-read from the domain. A USSD
-- session is a cursor into the product, not a second copy of it.

CREATE TABLE ussd_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  -- The provider's own session identifier. Unique per provider so two gateways
  -- can never collide, and so a replay maps back to exactly one session.
  provider_session_id text NOT NULL,
  -- SHA-256 of the E.164 number. Enough to recognise a caller across steps and
  -- to rate-limit them; useless to anyone who reads the table.
  phone_hash text NOT NULL,
  -- True only when the provider callback itself was verified. An MSISDN from an
  -- unverified callback is a claim, not an identity.
  msisdn_verified boolean NOT NULL DEFAULT false,
  -- Bound only to an identity that ALREADY exists. USSD never creates one.
  user_id uuid REFERENCES users(id),
  locale text NOT NULL DEFAULT 'fr',
  flow text NOT NULL DEFAULT 'menu',
  step text NOT NULL DEFAULT 'root',
  -- Navigation cursor only: selected ids, page number, pending draft. Never a
  -- fare, a seat count or a payment status — those are re-read, never cached,
  -- because a cached price is a price that can be wrong.
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','expired','cancelled')),
  steps integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX ussd_sessions_provider_session ON ussd_sessions(provider, provider_session_id);
-- Cleanup and the "is this still alive?" check.
CREATE INDEX ussd_sessions_expiry ON ussd_sessions(expires_at) WHERE status = 'active';
-- Per-caller rate limiting without ever selecting on a phone number.
CREATE INDEX ussd_sessions_caller ON ussd_sessions(phone_hash, created_at DESC);

-- Replay protection. Gateways retry aggressively on timeout, and a retried
-- "confirm booking" must return the first answer rather than book twice.
CREATE TABLE ussd_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES ussd_sessions(id) ON DELETE CASCADE,
  -- Hash of (session, step index, input): the same input at the same point is
  -- the same request, and gets the same reply.
  request_hash text NOT NULL,
  response_text text NOT NULL,
  continues boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ussd_requests_idempotent ON ussd_requests(session_id, request_hash);
