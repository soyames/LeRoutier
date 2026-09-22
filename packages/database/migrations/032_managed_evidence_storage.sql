-- Managed storage for verification evidence.
--
-- Until now a proof was an https link the operator hosted themselves, and that
-- carried one consequence the product had to keep saying out loud: access was
-- NOT server-authorized. Anybody holding the link could open it, LeRoutier
-- could not revoke it, could not expire it, and could not tell whether it had
-- ever been private.
--
-- These columns let the same evidence row point at an object LeRoutier holds
-- instead. Both shapes coexist deliberately: a dossier submitted before a
-- storage provider exists stays readable and reviewable, and the row itself
-- says which arrangement it is under rather than leaving a reviewer to guess
-- from whether a URL happens to be set.
--
-- storage_key is OPAQUE. It is never a URL, never derived from the operator's
-- name or the document kind in a guessable way, and never returned to any
-- client — a reviewer receives a short-lived grant from the API, not a key.
ALTER TABLE verification_evidence ADD COLUMN storage_key text;
ALTER TABLE verification_evidence ADD COLUMN storage_provider text;
ALTER TABLE verification_evidence ADD COLUMN content_type text;
ALTER TABLE verification_evidence ADD COLUMN byte_size integer CHECK (byte_size IS NULL OR byte_size > 0);

-- A managed row names its provider; a linked row does not. Stated as a
-- constraint so the two can never be half-mixed by a partial write, which is
-- how a row ends up with a key nothing can read.
ALTER TABLE verification_evidence ADD CONSTRAINT verification_evidence_storage_pairing
  CHECK ((storage_key IS NULL) = (storage_provider IS NULL));

-- Redaction already clears reference and file_url. A managed row must also
-- lose its key, or the pointer outlives the decision to forget the document.
-- Enforced rather than trusted to the scan that does it.
ALTER TABLE verification_evidence ADD CONSTRAINT verification_evidence_redaction_clears_storage
  CHECK (redacted_at IS NULL OR storage_key IS NULL);

CREATE INDEX verification_evidence_storage ON verification_evidence(storage_provider) WHERE storage_key IS NOT NULL;
