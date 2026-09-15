ALTER TABLE users ADD COLUMN auth_issuer text;
ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN profile_completed_at timestamptz;
ALTER TABLE operators ADD COLUMN provisioning_key text UNIQUE;
ALTER TABLE operators ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE places ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE stops ADD COLUMN created_by uuid REFERENCES users(id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES users(id),
  action text NOT NULL, entity_id uuid NOT NULL, operator_id uuid REFERENCES operators(id),
  details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_operator_time ON audit_events(operator_id,created_at DESC);
CREATE FUNCTION immutable_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit events are append only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();

CREATE TABLE provisioning_requests (
  actor_id uuid NOT NULL REFERENCES users(id), idempotency_key text NOT NULL,
  fingerprint text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,idempotency_key)
);
CREATE TABLE bootstrap_receipt (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), fingerprint text NOT NULL,
  operator_id uuid NOT NULL REFERENCES operators(id), ops_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- New service assignments cannot attach a disabled identity or inactive operator.
CREATE OR REPLACE FUNCTION assignment_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s services; v vehicles; d driver_profiles;
BEGIN
  SELECT * INTO s FROM services WHERE id=NEW.service_id;
  SELECT * INTO v FROM vehicles WHERE id=NEW.vehicle_id;
  SELECT * INTO d FROM driver_profiles WHERE user_id=NEW.driver_id;
  IF s.operator_id<>v.operator_id OR s.operator_id<>d.operator_id OR v.capacity<s.capacity OR NOT d.active OR v.status<>'active'
    OR NOT EXISTS(SELECT 1 FROM users WHERE id=d.user_id AND active=true AND role='driver' AND operator_id=s.operator_id)
    OR NOT EXISTS(SELECT 1 FROM operators WHERE id=s.operator_id AND active=true) THEN
    RAISE EXCEPTION 'Assignment does not match active service operator, driver or capacity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
