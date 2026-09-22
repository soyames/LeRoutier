-- What an outbound channel is currently able to do, and why not.
--
-- Two problems, one table.
--
-- THE RETRY STORM. The dispatcher retries a failed delivery five times with
-- backoff, which is right for a timeout and wrong for a daily allowance that
-- has run out. Brevo Free sends 300 messages a day; once that is spent, every
-- queued notification would attempt, fail, and attempt again four more times,
-- hammering a provider that has already said no — and burning the rate-limit
-- budget that the NEXT day's first messages need. Suppression has to outlive
-- the process that discovered it, and on serverless nothing in memory does.
--
-- THE OPS QUESTION. "Is email working, and how close are we to the ceiling?"
-- has to be answerable without calling the provider on every console page
-- load, and without anybody reading a recipient address or a message body to
-- find out.
--
-- Deliberately NON-SENSITIVE throughout. No recipient, no subject, no body, no
-- API key, no provider message. `reason` is one of LeRoutier's own words, never
-- a provider string and never an HTTP status — those stay in the delivery
-- audit where only the platform can see them, and are never rendered to a
-- passenger, a driver, an operator or a reviewer.
CREATE TABLE IF NOT EXISTS notification_channel_state (
  channel text PRIMARY KEY CHECK (channel IN ('in_app','web_push','sms','whatsapp','email')),

  -- Stop attempting until this moment. NULL means the channel may attempt.
  -- Set when the daily allowance is spent (until it resets), when the provider
  -- rate-limits us (until it says we may return), and when configuration is
  -- wrong (until somebody fixes it, which is why that one has no natural
  -- expiry and is cleared by a successful send).
  suppressed_until timestamptz,
  -- LeRoutier's vocabulary, not the provider's:
  --   quota_exhausted        the plan's allowance for the period is spent
  --   rate_limited           too many requests, provider asked us to wait
  --   provider_unavailable   the provider failed or could not be reached
  --   invalid_configuration  credentials or sender are wrong; retrying cannot help
  suppression_reason text CHECK (suppression_reason IN
    ('quota_exhausted','rate_limited','provider_unavailable','invalid_configuration')),

  -- Last observed request-rate budget, as the provider reported it on its own
  -- responses. Counts only; nothing here identifies a message or a person.
  rate_limit_remaining integer,
  rate_limit_resets_at timestamptz,

  -- The most recent outcome, in the same vocabulary, plus when the channel
  -- last actually delivered something. A channel that has never succeeded and
  -- a channel that succeeded an hour ago look very different to whoever is
  -- deciding whether to trust it.
  last_outcome text,
  last_outcome_at timestamptz,
  last_success_at timestamptz,

  updated_at timestamptz NOT NULL DEFAULT now()
);

-- in_app is served from this database and is the fallback that must always
-- work, so it is seeded unsuppressed and nothing is expected to suppress it.
INSERT INTO notification_channel_state (channel) VALUES ('in_app') ON CONFLICT DO NOTHING;
