-- When an account was last used to sign in.
--
-- Platform Ops could see that an account HAS an external identity, and when it
-- was created, but not whether anybody had signed into it since. That is the
-- fact every account-lifecycle decision turns on: dormant or active, worth
-- chasing or worth closing.
--
-- Deliberately nullable, with NO default. Every account that already exists
-- starts NULL and reads as "never observed", because no login history was
-- recorded before this column and inventing one would make the column worse
-- than useless — a dashboard that is confidently wrong is consulted, and a
-- dashboard that is honestly empty is investigated.
--
-- last_meaningful_activity_at is a different fact and stays: it means "booked
-- or shipped something", which is what retention measures. Signing in and
-- doing business are not the same signal and are not collapsed into one.
--
-- Write cost is bounded on purpose. Identity mapping runs on every
-- authenticated request, so writing this on each one would add a row update
-- per API call to an allowance the platform already refuses new registrations
-- to protect. It is refreshed at most once an hour per account, which is
-- precise enough for "when was this last used" and costs nothing measurable.
ALTER TABLE users ADD COLUMN last_authenticated_at timestamptz;

CREATE INDEX users_last_authenticated ON users(last_authenticated_at DESC NULLS LAST);
