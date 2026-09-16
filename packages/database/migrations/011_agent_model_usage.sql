-- Model-assisted agent reasoning: usage accounting and recorded recommendations.
--
-- Two things make this table necessary rather than nice to have.
--
-- Budget. The platform runs on free remote model capacity, and the API runs as
-- serverless functions, so an in-process counter would reset constantly and
-- enforce nothing. The budget has to live where every instance can see it.
--
-- Accountability. A model produces a *recommendation*, never an action. What it
-- proposed, what LeRoutier decided about that proposal, and whether a human
-- ever saw it all have to be reconstructable afterwards.
--
-- What is deliberately NOT stored: the prompt, the completion text, and any
-- party data. Only a hash of the task input, so a repeat of the same situation
-- can be suppressed without keeping the situation.

CREATE TABLE agent_model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  provider text NOT NULL,
  task text NOT NULL,
  workflow text,
  workflow_run_id uuid REFERENCES workflow_runs(id),
  requested_model text NOT NULL,
  -- What the provider actually served. Free routing may substitute a model, and
  -- an evaluation that does not know which model answered is worthless.
  actual_model text,
  status text NOT NULL CHECK(status IN ('ok','rejected','error','timeout','unavailable','budget_exceeded','suppressed')),
  latency_ms integer CHECK(latency_ms IS NULL OR latency_ms >= 0),
  -- SHA-256 of the projected task input. Never the input itself.
  input_hash text NOT NULL,
  -- The structured proposal, after schema validation. No free text from the
  -- model is ever stored as though it were a decision.
  recommendation jsonb,
  -- Why LeRoutier refused to act on it, when it did.
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The budget query: how many calls today.
CREATE INDEX agent_model_calls_day ON agent_model_calls(day, provider);
-- Per-workflow caps and duplicate suppression.
CREATE INDEX agent_model_calls_workflow ON agent_model_calls(workflow, day);
CREATE INDEX agent_model_calls_dedup ON agent_model_calls(input_hash, day) WHERE status = 'ok';
