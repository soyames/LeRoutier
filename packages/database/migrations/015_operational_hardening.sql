-- Additive metadata; no production GPS is deleted by this migration.
ALTER TABLE route_geometries ADD COLUMN duration_s integer CHECK(duration_s > 0);
ALTER TABLE route_geometries ADD COLUMN legs jsonb;
ALTER TABLE services ADD COLUMN gps_retain_until timestamptz;
ALTER TABLE workflow_runs ADD COLUMN operator_id uuid REFERENCES operators(id);
ALTER TABLE workflow_runs ADD COLUMN event_fingerprint text;
CREATE UNIQUE INDEX workflow_event_once ON workflow_runs(workflow,event_fingerprint) WHERE event_fingerprint IS NOT NULL;
UPDATE workflow_runs w SET operator_id=s.operator_id FROM services s WHERE s.id=w.aggregate_id;
UPDATE workflow_runs w SET operator_id=s.operator_id FROM incidents i JOIN services s ON s.id=i.service_id WHERE i.id=w.aggregate_id;
UPDATE workflow_runs w SET operator_id=p.operator_id FROM parcels p WHERE p.id=w.aggregate_id;
UPDATE workflow_runs w SET operator_id=a.operator_id FROM agent_principals a WHERE a.id=w.principal_id;

-- Dispatch identity must be an event, not an entity: two delays of the same
-- service are distinct notifications. Old rows remain intact.
ALTER TABLE notifications ADD COLUMN source_event_id uuid REFERENCES outbox(id);
DROP INDEX notifications_once;
CREATE UNIQUE INDEX notifications_once ON notifications(source_event_id,policy_id,coalesce(user_id::text,contact));
CREATE UNIQUE INDEX notifications_direct_once ON notifications(source_event_id,coalesce(user_id::text,contact)) WHERE policy_id IS NULL;
ALTER TABLE outbox ADD COLUMN dispatch_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN dispatch_retry_at timestamptz;
ALTER TABLE outbox ADD COLUMN dispatch_dead_at timestamptz;
ALTER TABLE notification_deliveries ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE notification_deliveries ADD COLUMN lease_until timestamptz;
CREATE TABLE notification_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operational_signals (
  minute timestamptz NOT NULL DEFAULT date_trunc('minute',now()),
  signal text NOT NULL,
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY(minute,signal)
);
