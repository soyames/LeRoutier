-- Retention for verification evidence.
--
-- This was the one category with no policy at all, and it holds the most
-- sensitive data on the platform: national identity references, driving
-- licence numbers, and links to documents LeRoutier does not host and cannot
-- revoke. Everything else — GPS, assistant messages, notification bodies,
-- exports — had a stated duration and a scan behind it. A carte grise did not.
--
-- The policy applies to REFUSED dossiers only, and that distinction is the
-- whole design:
--
--   An operator that was rejected never became an operator. There is no
--   accounting relationship, no settlement, no dispute to defend, and
--   therefore no reason to keep a pointer to that person's identity card
--   indefinitely. After the appeal window the pointers are redacted.
--
--   A verified or suspended operator is a different case: that relationship
--   existed, passengers travelled under it, and the dossier is the evidence
--   that LeRoutier checked before letting it carry anybody. Those are never
--   swept automatically.
--
-- What survives a redaction is the decision itself: which proof, what was
-- decided, when, and by whom. The record that a review happened is the part
-- with lasting value; the copy of somebody's passport is not.
ALTER TABLE retention_policies DROP CONSTRAINT retention_policies_data_category_check;
ALTER TABLE retention_policies ADD CONSTRAINT retention_policies_data_category_check
  CHECK (data_category IN
    ('raw_gps','assistant_messages','technical_logs','inactive_accounts','booking_records',
     'payment_records','parcel_records','notification_history','support_requests',
     'consent_records','audit_records','data_exports','kyc_evidence'));

-- 90 days: long enough for a refused applicant to come back, appeal and be
-- re-examined, short enough that a refusal does not become a permanent file.
-- An operational default like every other duration here, and revisable in the
-- table rather than in code.
INSERT INTO retention_policies(data_category,retention_days,action,legal_basis_or_reason) VALUES
  ('kyc_evidence',90,'anonymize','refused dossiers: identity pointers redacted, review decision retained');

-- Marks a row whose document pointers have been cleared, so a redaction is
-- distinguishable from a dossier that never carried a document — and so the
-- scan does not keep reselecting rows it has already handled.
ALTER TABLE verification_evidence ADD COLUMN redacted_at timestamptz;

-- The row-level CHECK requires a reference or a file; a redacted row has
-- neither, and must still be allowed to exist as the record of a decision.
ALTER TABLE verification_evidence DROP CONSTRAINT verification_evidence_check;
ALTER TABLE verification_evidence ADD CONSTRAINT verification_evidence_check
  CHECK (redacted_at IS NOT NULL OR reference IS NOT NULL OR file_url IS NOT NULL);

CREATE INDEX verification_evidence_redaction ON verification_evidence(operator_id) WHERE redacted_at IS NULL;
