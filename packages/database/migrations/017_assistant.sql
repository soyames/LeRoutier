-- LeRoutier Assistant audit trail. Every conversation turn is recorded:
-- session, actor, resolved intent, tools invoked, outcome and which model —
-- if any — phrased the answer. Never stored: raw messages beyond their
-- hash, hidden reasoning, tokens, credentials, pickup codes, or PII.
CREATE TABLE assistant_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL CHECK(char_length(session_id) BETWEEN 8 AND 64),
  actor_id uuid REFERENCES users(id),
  role text NOT NULL DEFAULT 'anonymous' CHECK(role IN ('anonymous','passenger','driver','convoyeur','ops')),
  intent text NOT NULL,
  tools jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK(status IN ('answered','model_explained','fallback','refused','budget_exceeded')),
  provider_used text,
  fallback_used boolean NOT NULL DEFAULT false,
  input_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_events_actor ON assistant_events(actor_id,created_at DESC);
