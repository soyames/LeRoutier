-- Events that were emitted and heard by nobody.
--
-- Three gaps, all of them the same shape: the domain recorded that something
-- happened, and no policy consumed it, so the person who needed to act never
-- found out. A queue nobody is told about is a queue nobody works.
--
--   1. A dossier arrives for review. The operator waits; Platform Ops has no
--      reason to open the screen.
--   2. A corrected proof arrives. This is the other half of the correction
--      loop: an operator can now replace a refused document, and until now
--      nothing told the reviewer it had happened, so the fix sat unreviewed.
--   3. A DRIVER's payout completes or fails. Operator payouts had policies;
--      driver payouts did not, so somebody waiting on money was told nothing
--      either way — including when it failed and their balance came back.
--
-- Also: a payout waiting for approval. Platform Ops is the approver, and an
-- approval nobody is told about is money sitting still.

-- A payout's beneficiary is a person, reached through the payout itself rather
-- than through a service or a parcel. None of the existing audiences can walk
-- from a payout request to the driver waiting on it.
ALTER TABLE notification_policies DROP CONSTRAINT notification_policies_audience_check;
ALTER TABLE notification_policies ADD CONSTRAINT notification_policies_audience_check
  CHECK (audience IN ('booking_passenger','service_passengers','service_driver_independent',
    'service_driver_company','service_convoyeur','operator_ops','platform_ops','operator_owner',
    'parcel_sender','parcel_receiver','point_proposer','payout_beneficiary'));

INSERT INTO notification_policies(event_type,payload_match,audience,category,severity,template,channels,mandatory,entity_type) VALUES
  -- Review work arriving. Operational rather than critical: it is somebody's
  -- job, not an emergency, and it must not be switchable off by preference
  -- because the queue would then silently stop being worked.
  ('operator.onboarded','{}','platform_ops','operational','info','ops_dossier_submitted','[]',true,'none'),
  ('operator.evidence_resubmitted','{}','platform_ops','operational','info','ops_evidence_resubmitted','[]',true,'none'),
  ('payout.requested','{}','platform_ops','operational','info','ops_payout_requested','[]',true,'payout'),
  ('operator_payout.requested','{}','platform_ops','operational','info','ops_payout_requested','[]',true,'payout'),

  -- Somebody's money. Critical and mandatory: a driver does not opt out of
  -- being told whether they were paid, and a failure is the more important of
  -- the two because their balance has just come back and they will wonder why.
  ('payout.paid','{}','payout_beneficiary','critical','info','payout_paid','[]',true,'payout'),
  ('payout.failed','{}','payout_beneficiary','critical','urgent','payout_failed','[]',true,'payout');
