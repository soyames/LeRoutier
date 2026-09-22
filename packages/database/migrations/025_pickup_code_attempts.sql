-- Per-parcel pickup-code attempt accounting.
--
-- A pickup code is six digits: 900 000 possibilities, valid for fifteen
-- minutes. The only limit on guessing it was the generic per-identity request
-- limiter, which allows 120 mutations a minute — roughly 1 800 guesses inside
-- one code's lifetime, from an actor (the assigned driver, a station clerk)
-- who is already standing next to the parcel. Repeated across parcels and
-- days that is a practical way to take somebody else's shipment.
--
-- The counter lives in its own table rather than as a column on
-- parcel_pickup_codes for one reason that matters: a rejected attempt rolls
-- its verification transaction back, so a counter stored alongside the code
-- would be rolled back with it and every wrong guess would stay free. This is
-- written in a separate transaction, keyed by parcel and hour so it drains
-- without a sweeper.
CREATE TABLE parcel_pickup_attempts (
  parcel_id uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
  window_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  PRIMARY KEY (parcel_id, window_at)
);
