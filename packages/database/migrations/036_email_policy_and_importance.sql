-- Which events are worth an email, and which matter most when there are few
-- emails left.
--
-- Brevo Free sends 300 messages a day. That is plenty for a pilot and nothing
-- like enough to email somebody every time a vehicle reaches a stop, so the
-- question "does this event deserve an email" now has an answer stored beside
-- the event rather than decided in code.
--
-- The catalogue already expressed channel choice as data — `channels` on each
-- policy — so this adds rows' worth of intent to the existing table and
-- invents no event, no template and no second mechanism. Everything not named
-- below keeps exactly the channels it had.
--
-- IMPORTANCE decides what survives when the day's allowance is nearly spent:
--
--   high      somebody must act, or something they planned has changed.
--             A cancelled trip, a rejected document, a failed payout, a parcel
--             waiting to be collected. These keep sending until the allowance
--             is genuinely gone.
--   normal    the transactional record of something that worked. The combined
--             booking confirmation, an approval, a completed payout.
--   optional  pleasant to receive and not needed. Suppressed first, and only
--             the EMAIL is suppressed — the in-app notification is created and
--             read exactly as before, because the application, not the inbox,
--             is where LeRoutier's state lives.
-- IF NOT EXISTS because a migration must be re-runnable. Migrations run once
-- in normal life, but the case this protects is the one that already happened
-- here once: a ledger that has lost a row, where the only way back is to
-- re-apply. A migration that cannot be replayed turns a recoverable drift into
-- a manual repair.
ALTER TABLE notification_policies
  ADD COLUMN IF NOT EXISTS importance text NOT NULL DEFAULT 'normal';
ALTER TABLE notification_policies DROP CONSTRAINT IF EXISTS notification_policies_importance_check;
ALTER TABLE notification_policies ADD CONSTRAINT notification_policies_importance_check
  CHECK (importance IN ('high','normal','optional'));

-- Email is appended to the policy's existing channel order rather than
-- replacing it; the dispatcher still appends in_app last, so every one of
-- these remains readable in the app whether or not the message is ever sent.
CREATE OR REPLACE FUNCTION pg_temp.add_email(p_event text, p_audience text, p_template text, p_importance text)
RETURNS void LANGUAGE sql AS $$
  UPDATE notification_policies
     SET channels = CASE WHEN channels @> '["email"]'::jsonb THEN channels ELSE channels || '["email"]'::jsonb END,
         importance = p_importance
   WHERE active AND event_type = p_event AND audience = p_audience AND template = p_template;
$$;

-- ---- high: somebody has to know, or has to do something ---------------------
-- A trip that is not happening, or is happening differently.
SELECT pg_temp.add_email('booking.cancelled','booking_passenger','booking_cancelled','high');
SELECT pg_temp.add_email('service.status','service_passengers','service_cancelled','high');
SELECT pg_temp.add_email('service.rescheduled','service_passengers','service_delayed','high');
SELECT pg_temp.add_email('service.boarding_point_changed','service_passengers','boarding_point_changed','high');
-- Money that did not arrive.
SELECT pg_temp.add_email('payment.failed','booking_passenger','payment_failed','high');
SELECT pg_temp.add_email('payout.failed','payout_beneficiary','payout_failed','high');
SELECT pg_temp.add_email('operator_payout.failed','operator_owner','payout_failed','high');
-- A dossier that cannot proceed until the operator acts.
SELECT pg_temp.add_email('operator.evidence_reviewed','operator_owner','operator_evidence_rejected','high');
SELECT pg_temp.add_email('operator.verification_changed','operator_owner','operator_verification_rejected','high');
SELECT pg_temp.add_email('operator.verification_changed','operator_owner','operator_suspended','high');
-- A parcel sitting at a station waiting for somebody to come for it.
SELECT pg_temp.add_email('parcel.ready_for_pickup','parcel_receiver','parcel_ready_for_pickup','high');

-- ---- normal: the record of something that worked ----------------------------
-- ONE email for the whole successful booking transaction. booking.confirmed
-- fires once payment has been confirmed, and the ticket_ready template already
-- carries the trip, the seat, the amount paid, any refund, and the link to the
-- ticket and its receipt. payment.succeeded therefore does NOT get an email:
-- three messages for one purchase is three times the quota and one more thing
-- to read.
SELECT pg_temp.add_email('booking.confirmed','booking_passenger','ticket_ready','normal');
SELECT pg_temp.add_email('operator.verification_changed','operator_owner','operator_verified','normal');
SELECT pg_temp.add_email('payout.paid','payout_beneficiary','payout_paid','normal');
SELECT pg_temp.add_email('operator_payout.paid','operator_owner','payout_paid','normal');
SELECT pg_temp.add_email('parcel.accepted','parcel_sender','parcel_accepted','normal');

-- ---- optional: nice to have, first to go -----------------------------------
SELECT pg_temp.add_email('parcel.collected','parcel_sender','parcel_collected','optional');

-- ---- explicitly NOT email ---------------------------------------------------
-- Stated so the next person does not have to infer it from an absence. These
-- are the high-frequency operational events: position, progress, custody and
-- internal state. They remain in-app, they remain audited, and they cost no
-- quota. Marking them `optional` also means that if anybody ever adds email to
-- one, quota pressure drops it first.
UPDATE notification_policies SET importance = 'optional'
 WHERE active AND template IN (
   'passenger_boarded','arrival_completed','booking_created','crew_walkup_recorded',
   'crew_next_station','crew_recovery','crew_service_rescheduled','crew_boarding_point_changed',
   'parcel_in_transit','parcel_loaded','parcel_arrived','parcel_eta_updated','parcel_delayed',
   'crew_parcel_to_load','crew_parcel_to_unload','crew_parcel_exception',
   'settlement_credited','boarding_point_moderated');
