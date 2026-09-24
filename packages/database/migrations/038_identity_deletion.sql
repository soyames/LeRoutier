-- Automatic Firebase identity deletion during account deletion.
--
-- The processor captures the provider UID before the tombstone anonymizes
-- users.auth_subject (the one durable trace), deletes the Firebase
-- Authentication user OUTSIDE any database transaction, then completes the
-- anonymization. `processing` marks a request whose provider step is in flight
-- or awaiting retry — the tick re-claims it and treats an already-deleted
-- identity as success, which makes the whole step idempotent across crashes.
ALTER TABLE deletion_requests ADD COLUMN identity_uid text;
ALTER TABLE deletion_requests ADD COLUMN identity_deleted_at timestamptz;
