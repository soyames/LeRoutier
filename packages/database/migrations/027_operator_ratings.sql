-- Passenger ratings of the operator who actually carried them.
--
-- The primary key is the booking, which is the whole anti-abuse design: a
-- rating requires a journey that reached 'completed', and one journey can
-- leave exactly one rating. There is no anonymous review form to flood, no
-- second rating after a refund argument, and no way to rate an operator you
-- never travelled with.
--
-- The passenger is recorded so somebody can withdraw or amend their own
-- rating, and so a pattern of abuse is traceable. It is never published:
-- ratings are shown as an aggregate, and the comment carries no name.
CREATE TABLE operator_ratings (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  passenger_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score integer NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment text CHECK (comment IS NULL OR length(comment) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operator_ratings_operator ON operator_ratings(operator_id);
CREATE INDEX operator_ratings_passenger ON operator_ratings(passenger_id);

-- The aggregate lives on the operator so the public search does not carry a
-- correlated subquery per row. It is maintained in the same transaction as the
-- rating, so it can never drift from the rows it summarises.
ALTER TABLE operators ADD COLUMN rating_total integer NOT NULL DEFAULT 0;
ALTER TABLE operators ADD COLUMN rating_count integer NOT NULL DEFAULT 0;
