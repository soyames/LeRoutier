-- Integrated privacy, consent, retention and account deletion. Additive only:
-- no production row is changed or deleted by this migration. Financial,
-- booking, parcel and audit truth is never cascaded away — deletion means
-- anonymization into a tombstone identity, and retention honors holds.

-- Versioned consent tracking (user-facing consents; REQUIRED service
-- processing is never modelled as an optional checkbox).
CREATE TABLE user_consents (
  user_id uuid NOT NULL REFERENCES users(id),
  consent_type text NOT NULL CHECK(consent_type IN ('marketing','partner_offers','optional_analytics')),
  policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','withdrawn')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  source text NOT NULL DEFAULT 'web' CHECK(source IN ('web','ussd','support')),
  locale text NOT NULL DEFAULT 'fr',
  PRIMARY KEY(user_id,consent_type,policy_version)
);
CREATE INDEX user_consents_active ON user_consents(user_id,consent_type) WHERE status='accepted';

-- Policy acknowledgement for Terms and Privacy versions.
CREATE TABLE policy_acknowledgements (
  user_id uuid NOT NULL REFERENCES users(id),
  policy text NOT NULL CHECK(policy IN ('terms','privacy_policy')),
  policy_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'web',
  locale text NOT NULL DEFAULT 'fr',
  PRIMARY KEY(user_id,policy,policy_version)
);

-- One configurable retention-policy mechanism; durations are operational
-- defaults pending legal validation unless a decision already exists
-- (raw GPS: 30 days).
CREATE TABLE retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_category text NOT NULL UNIQUE CHECK(data_category IN
    ('raw_gps','assistant_messages','technical_logs','inactive_accounts','booking_records',
     'payment_records','parcel_records','notification_history','support_requests',
     'consent_records','audit_records','data_exports')),
  retention_days integer NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),
  action text NOT NULL DEFAULT 'delete' CHECK(action IN ('delete','anonymize','aggregate','retain','review')),
  enabled boolean NOT NULL DEFAULT true,
  legal_basis_or_reason text NOT NULL DEFAULT 'operational default / pending legal validation',
  hold_eligible boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz
);
INSERT INTO retention_policies(data_category,retention_days,action,legal_basis_or_reason) VALUES
  ('raw_gps',30,'delete','project decision: raw positions of finished services'),
  ('assistant_messages',90,'delete','operational default / pending legal validation'),
  ('technical_logs',30,'delete','operational default / pending legal validation'),
  ('inactive_accounts',365,'review','operational default / pending legal validation'),
  ('booking_records',1825,'retain','operational and accounting evidence'),
  ('payment_records',3650,'retain','financial and accounting evidence'),
  ('parcel_records',1825,'retain','custody and dispute evidence'),
  ('notification_history',180,'anonymize','delivery metadata retained, bodies trimmed'),
  ('support_requests',730,'retain','dispute handling'),
  ('consent_records',3650,'retain','consent audit evidence'),
  ('audit_records',3650,'retain','security and legal evidence'),
  ('data_exports',1,'delete','short-lived export artifacts');

-- Generalized legal/audit holds. A held record is never touched by normal
-- retention cleanup. GPS keeps its per-service column as the incident hold.
CREATE TABLE legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL CHECK(subject_kind IN ('user','service','parcel','payment','incident')),
  subject_id uuid NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 2 AND 500),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  released_at timestamptz,
  CHECK(expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX legal_holds_subject ON legal_holds(subject_kind,subject_id) WHERE released_at IS NULL;

-- Account deletion lifecycle. Processing anonymizes; it never cascades.
CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  status text NOT NULL DEFAULT 'requested' CHECK(status IN
    ('requested','pending_review','scheduled','processing','completed','rejected_or_blocked')),
  blockers jsonb NOT NULL DEFAULT '[]',
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Short-lived personal-data exports: the artifact expires and is purged.
CREATE TABLE data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','downloaded','expired','failed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_exports_user ON data_exports(user_id,created_at DESC);

-- Inactive-account lifecycle on the canonical user row. Meaningful activity
-- is a successful login, a booking, a parcel transaction, a support
-- interaction or an explicit keep-account confirmation — never a background
-- technical request.
ALTER TABLE users ADD COLUMN last_meaningful_activity_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN retention_due_at timestamptz;
ALTER TABLE users ADD COLUMN retention_notification_sent_at timestamptz;
ALTER TABLE users ADD COLUMN keep_confirmed_at timestamptz;
