-- Telling an operator what was decided about their dossier.
--
-- The verification decisions were already written to the outbox and nothing
-- consumed them. An operator learned the outcome by opening the app and
-- noticing — which makes the correction loop unusable in practice: a refused
-- carte grise is only fixable by somebody who knows it was refused, and
-- nothing told them.
--
-- Four decisions are worth interrupting somebody for, and all four are
-- mandatory: whether you may legally carry passengers on this platform is not
-- a marketing preference.
--
-- Both audiences are listed for every policy because the two operator shapes
-- keep their accountable person in different places: operator_owner resolves
-- the owner of an INDEPENDENT operator, operator_ops resolves the staff of a
-- company. One of the two returns nobody on any given operator, which costs a
-- lookup and removes a whole class of "companies never got this one" bug.
--
-- channels is left at in_app only. No external provider is configured, and a
-- policy naming SMS would be a claim rather than a plan; when a provider
-- exists these rows are where it is added.
INSERT INTO notification_policies(event_type,payload_match,audience,category,severity,template,channels,mandatory,entity_type) VALUES
  ('operator.verification_changed','{"status":"verified"}','operator_owner','critical','info','operator_verified','[]',true,'none'),
  ('operator.verification_changed','{"status":"verified"}','operator_ops','critical','info','operator_verified','[]',true,'none'),
  ('operator.verification_changed','{"status":"rejected"}','operator_owner','critical','urgent','operator_verification_rejected','[]',true,'none'),
  ('operator.verification_changed','{"status":"rejected"}','operator_ops','critical','urgent','operator_verification_rejected','[]',true,'none'),
  ('operator.verification_changed','{"status":"suspended"}','operator_owner','critical','urgent','operator_suspended','[]',true,'none'),
  ('operator.verification_changed','{"status":"suspended"}','operator_ops','critical','urgent','operator_suspended','[]',true,'none'),
  -- The one that closes the loop: a refused proof is the only thing the
  -- operator can actually act on, and it is the reason the dossier is stuck.
  ('operator.evidence_reviewed','{"decision":"rejected"}','operator_owner','critical','urgent','operator_evidence_rejected','[]',true,'none'),
  ('operator.evidence_reviewed','{"decision":"rejected"}','operator_ops','critical','urgent','operator_evidence_rejected','[]',true,'none');
