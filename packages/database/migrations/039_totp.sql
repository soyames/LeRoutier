-- A second factor for identities that choose to have one: TOTP, the six-digit
-- code an authenticator app derives from a shared secret and the clock.
--
-- WHY THIS IS OURS AND NOT FIREBASE'S. Firebase Authentication's multi-factor
-- support lives in Identity Platform — Google's own comparison lists MFA as
-- available there and NOT in base Firebase Authentication — and Identity
-- Platform is a paid product. LeRoutier runs on the free tier by owner
-- constraint, so the factor is implemented here. RFC 6238 is HMAC-SHA1 over a
-- shared secret and a time step; it needs no vendor, no network and no billing.
-- It also keeps the rule this project applies to every other permission: the
-- database decides, and nothing a token claims is trusted on its own.
--
-- WHAT A SECOND FACTOR DOES AND DOES NOT DEFEND. It defends against a stolen
-- or guessed PASSWORD — the thing an attacker can obtain without ever touching
-- this database. It is not a defence against somebody who can already read
-- these tables, and the design does not pretend otherwise (see `secret`).
--
-- The factor is OPT-IN, per identity. Nothing here changes sign-in for the
-- people who do not enrol.

-- One enrolment per identity.
CREATE TABLE IF NOT EXISTS user_totp (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The base32 shared secret, stored as issued.
  --
  -- Not encrypted, deliberately. Encrypting it needs a key that would itself
  -- have to live in the same deployment, so the only attack it would stop is a
  -- reader of this table who cannot also read the application's environment —
  -- a narrow gap, bought with a key-rotation story this deployment does not
  -- have. It matters less than it looks: anybody who can READ this table can
  -- also see that the factor exists, and anybody who can WRITE it can simply
  -- clear it. The honest description of this feature, shown to the user, is
  -- that it protects a compromised password, not a compromised database.
  secret text NOT NULL,
  -- NULL until a code has been proven once. An unconfirmed enrolment is NOT a
  -- factor and must never gate a sign-in: somebody who starts enrolling and
  -- abandons it would otherwise be shut out of their own account by a secret
  -- their authenticator never received.
  confirmed_at timestamptz,
  -- The last time step accepted. Codes are checked one step either side of now,
  -- which is the tolerance every authenticator app assumes, and without this a
  -- code observed over a shoulder would keep working for the rest of its
  -- window. Replay inside the window is the one thing TOTP does not solve by
  -- itself, so it is solved here.
  last_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Recovery codes, so losing a phone is not losing an account. This product has
-- no support desk to reset a locked-out passenger, which makes a way back in
-- non-optional rather than a convenience.
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the code. Unlike a password these are high-entropy values we
  -- generate ourselves, so there is no dictionary to run and no need for a
  -- slow KDF; a plain hash is the right tool and keeps sign-in fast.
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

-- A browser that has already passed the second factor.
--
-- LeRoutier sessions are stateless: the API verifies a Firebase ID token and
-- holds nothing. That is fine for "who is this", but "has this browser proved
-- the factor recently" has to live somewhere, and Firebase rotates its tokens
-- hourly — storing the answer against the token would demand a fresh code
-- every hour. Storing it in the database keeps the authority here rather than
-- in a cookie only this service could sign, and makes revocation a DELETE.
--
-- Only the hash of the token is kept, so a reader of this table cannot use it
-- to sign in, and expiry is enforced on read rather than by a sweeper.
CREATE TABLE IF NOT EXISTS totp_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS totp_sessions_user_idx ON totp_sessions(user_id);
-- Only unused codes are ever looked up, so the index covers exactly that.
CREATE INDEX IF NOT EXISTS user_recovery_codes_unused_idx ON user_recovery_codes(user_id) WHERE used_at IS NULL;
