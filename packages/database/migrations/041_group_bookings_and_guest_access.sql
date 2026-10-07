-- Buying several tickets in one purchase, and buying them without an account.
--
-- TWO CHANGES THAT BELONG TOGETHER, because the second is what makes the first
-- worth building. A visitor could review a trip anonymously but had to create an
-- account before paying for it — so the account was a toll gate on the way to a
-- ticket. Meanwhile the transport domain only knew how to sell one seat to one
-- passenger, which meant a family could not buy four seats together.
--
-- WHY THE GROUP IS AN ORDER AND NOT A BOOKING. A purchase of N tickets becomes N
-- rows in the existing per-seat booking table, each still one seat, one ticket,
-- one boarding event, one line on the driver's manifest — all of which keep
-- working exactly as they do for a single passenger. The purchase itself is a
-- separate, coarser record: one payment, one expiry, one idempotency key. Making
-- the coach-party a single booking would have meant re-teaching the manifest, the
-- scanner and the boarding flow that a booking can carry several people, which is
-- a much larger change to the part of the product that runs on a moving vehicle.
--
-- WHAT THE APP ALREADY HAD AND THIS FILE REUSES. A guest identity is not a new
-- concept here: walk-up counter sales already create a row in the user table with
-- no authentication subject, which is precisely "a passenger who never signs in".
-- Guest access is not a new mechanism either — the opaque session tokens the
-- development login uses are already an opaque-token table, so a guest session is
-- a row in it with a different kind.
--
-- NOT COVERED BY THE READINESS CHECK. The schema-drift check reads this file for
-- table creations and added columns only. The dropped NOT NULL, the CHECK
-- constraints, the unique indexes and the trigger below are invisible to it, so
-- a database missing them reports "current". They are verified by the test suite.
--
-- EVERY STATEMENT HERE IS SAFE TO RUN TWICE. Constraints and the trigger are
-- dropped before being created, the function is replaced, the one index that is
-- replaced says so, and everything else is IF NOT EXISTS or a query already
-- narrowed to the rows it has not yet touched. A migration that cannot be
-- re-applied cannot be repaired by re-applying it.

-- One purchase: the seats are in the booking table, this is the order.
CREATE TABLE IF NOT EXISTS booking_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  origin_sequence integer NOT NULL,
  destination_sequence integer NOT NULL,
  -- How many tickets were bought, and what one of them cost. The per-seat price
  -- is stored rather than divided out of the total later: integer division on a
  -- short payment would round in the passenger's favour, and the group total must
  -- always be exactly quantity x seat price.
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  seat_amount_minor integer NOT NULL CHECK (seat_amount_minor >= 0),
  amount_minor integer NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'XOF' CHECK (currency='XOF'),
  -- A coarse lifecycle for the purchase. After payment the seats are the truth —
  -- travellers board independently — so nothing here tries to track the state of
  -- individual seats beyond paid and unpaid.
  status text NOT NULL CHECK (status IN ('held','confirmed','cancelled','expired')),
  -- Who paid. For a guest purchase this is the guest identity, which the claim
  -- flow later hands to a real account.
  purchaser_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (origin_sequence < destination_sequence),
  CHECK (status <> 'held' OR expires_at IS NOT NULL),
  -- The arithmetic is a database invariant, not a convention. A total that does
  -- not equal the seats times the fare cannot confirm against anything.
  CHECK (amount_minor = quantity * seat_amount_minor),
  -- The idempotency anchor for the purchase. The booking table's own
  -- (passenger_id, idempotency_key) cannot serve here: one purchase writes N
  -- bookings that share a purchaser.
  UNIQUE (purchaser_id, idempotency_key),
  FOREIGN KEY (service_id, origin_sequence) REFERENCES service_stops(service_id, sequence),
  FOREIGN KEY (service_id, destination_sequence) REFERENCES service_stops(service_id, sequence)
);
CREATE INDEX IF NOT EXISTS booking_groups_expiry ON booking_groups(expires_at) WHERE status='held';
CREATE INDEX IF NOT EXISTS booking_groups_purchaser ON booking_groups(purchaser_id, created_at DESC);

-- Which purchase each seat belongs to. Single-ticket purchases made before this
-- change simply have nothing here, and every one of them keeps working.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES booking_groups(id);
CREATE INDEX IF NOT EXISTS bookings_group ON bookings(group_id) WHERE group_id IS NOT NULL;

-- A booking's purchase is decided when it is created, never after. Without this a
-- paid booking could be re-pointed at a different purchase and re-confirmed
-- against a payment that was never made for it.
CREATE OR REPLACE FUNCTION immutable_booking_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'A booking belongs to the purchase it was created in' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_group ON bookings;
CREATE TRIGGER immutable_group BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION immutable_booking_group();

-- A payment now settles either one seat or a whole purchase, never both and
-- never neither. The nullable column is what lets the aggregate payment live
-- beside the per-seat one without a second payment table.
ALTER TABLE payments ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES booking_groups(id);
-- Added unvalidated then validated separately: a plain ADD CONSTRAINT takes an
-- exclusive lock and checks every existing row in one step, and this table is
-- the ledger.
--
-- Dropped first so the file can be applied twice. Every statement in a migration
-- should be safe to run again — that is what makes a half-applied file fixable
-- by hand rather than by surgery — and this is the one place a plain CREATE
-- could not be written idempotently.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_target_check;
ALTER TABLE payments ADD CONSTRAINT payments_target_check
  CHECK ((booking_id IS NULL) <> (group_id IS NULL)) NOT VALID;
ALTER TABLE payments VALIDATE CONSTRAINT payments_target_check;

-- Replaces one_pending_payment, which indexed booking_id alone. Once that column
-- is nullable the old index stops constraining anything for a purchase: a unique
-- index treats NULLs as distinct, so an aggregate payment and a per-seat payment
-- could both be pending against the same seats. That is a double charge and a
-- double credit to the operator, so the guard moves onto the resolved target.
DROP INDEX IF EXISTS one_pending_payment;
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_payment_per_target
  ON payments(coalesce(booking_id, group_id)) WHERE status='pending';

-- Guest access. The development login already put opaque tokens in this table;
-- the column says which kind of principal a token belongs to, so a guest token is
-- recognised, scoped and revocable rather than being a second token mechanism.
ALTER TABLE api_sessions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'demo';
ALTER TABLE api_sessions DROP CONSTRAINT IF EXISTS api_sessions_kind_check;
ALTER TABLE api_sessions ADD CONSTRAINT api_sessions_kind_check CHECK (kind IN ('demo','guest')) NOT VALID;
ALTER TABLE api_sessions VALIDATE CONSTRAINT api_sessions_kind_check;
CREATE INDEX IF NOT EXISTS guest_sessions ON api_sessions(user_id, expires_at) WHERE kind='guest';

-- When a passenger identity became a passenger.
--
-- A new account is still provisioned on first sign-in — drivers and transport
-- companies arrive through the same door and their onboarding elevates the role
-- afterwards, so refusing to create identities would break exactly the accounts
-- that must keep working. What this column records is something narrower and
-- genuinely new: an account is not a *passenger* account, able to buy tickets,
-- until it has a purchase behind it.
--
-- Existing accounts are backfilled as activated. A returning passenger who
-- already has an account must keep booking exactly as before; the rule applies to
-- accounts created from here on.
ALTER TABLE users ADD COLUMN IF NOT EXISTS passenger_activated_at timestamptz;
UPDATE users SET passenger_activated_at = now()
  WHERE auth_subject IS NOT NULL AND role='passenger' AND passenger_activated_at IS NULL;
