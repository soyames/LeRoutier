-- Free-tier model capacity is opportunistic, not guaranteed. Measured against
-- the live Gemini free tier: 429 RESOURCE_EXHAUSTED arrives after a handful of
-- calls in quick succession. These two changes make that a state LeRoutier can
-- see and share rather than one each serverless instance rediscovers.

-- Why a call produced nothing, precisely enough to act on. A quota refusal is
-- operationally different from an outage or a bad answer: it ends by itself.
ALTER TABLE agent_model_calls ADD COLUMN quota_exhausted boolean NOT NULL DEFAULT false;
ALTER TABLE agent_model_calls ADD COLUMN cooldown_until timestamptz;

-- How often quota was the reason, per day, without scanning the table.
CREATE INDEX agent_model_calls_quota ON agent_model_calls(day) WHERE quota_exhausted;

-- The cooldown itself, shared by every instance.
--
-- An in-process window is forgotten when the instance is recycled, and the next
-- cold instance calls a provider that has already refused — which is how a rate
-- limit becomes a rate-limit storm at the moment capacity is scarcest. One row
-- per provider: a provider name, when it may be used again, and why.
--
-- No PII, no credential, and nothing a leak would make worse.
CREATE TABLE agent_model_cooldowns (
  provider text PRIMARY KEY,
  until_at timestamptz NOT NULL,
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
