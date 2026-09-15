-- Notifications as core infrastructure, plus first/last-mile journey support.
-- No second event bus: the existing outbox stays the only domain event stream.
-- A policy maps (event_type, payload_match) to an audience, category, template
-- and channel order; dispatch resolves recipients and records one delivery row
-- per channel. Unconfigured channels are recorded as unavailable, never sent.

-- Scheduled arrival, so a journey timeline can state arrival without inventing
-- one. NULL means "not scheduled" and the timeline says exactly that.
ALTER TABLE services ADD COLUMN arrival_at timestamptz;
ALTER TABLE services ADD CONSTRAINT services_arrival_after_departure
  CHECK(arrival_at IS NULL OR arrival_at > departure_at);

CREATE TABLE notification_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  -- Containment filter on the outbox payload: one event type can serve several
  -- policies (service.status with status=cancelled vs status=disrupted).
  payload_match jsonb NOT NULL DEFAULT '{}',
  audience text NOT NULL CHECK(audience IN ('booking_passenger','service_passengers','service_driver_independent',
    'service_driver_company','service_convoyeur','operator_ops','platform_ops','operator_owner',
    'parcel_sender','parcel_receiver','point_proposer')),
  category text NOT NULL CHECK(category IN ('critical','operational','marketing')),
  severity text NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','urgent')),
  template text NOT NULL,
  -- Preferred channel order; in_app is always appended by the dispatcher.
  channels jsonb NOT NULL DEFAULT '[]',
  -- Mandatory transactional alerts cannot be switched off by preference.
  mandatory boolean NOT NULL DEFAULT false,
  entity_type text NOT NULL DEFAULT 'none' CHECK(entity_type IN ('none','booking','service','parcel','payout','incident','boarding_point')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_type,audience,payload_match)
);
CREATE INDEX notification_policies_event ON notification_policies(event_type) WHERE active;

-- One notification per recipient per event. user_id is NULL for parcel parties,
-- who are phone contacts rather than LeRoutier identities.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid REFERENCES notification_policies(id),
  user_id uuid REFERENCES users(id),
  contact text,
  event_type text NOT NULL,
  category text NOT NULL CHECK(category IN ('critical','operational','marketing')),
  severity text NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','urgent')),
  template text NOT NULL,
  -- Rendered, already-safe content. Never holds pickup codes, ticket tokens or
  -- any party contact detail belonging to someone else.
  data jsonb NOT NULL DEFAULT '{}',
  entity_type text NOT NULL DEFAULT 'none',
  entity_id uuid,
  -- Timing advice is replaced, not duplicated, when a service is rescheduled.
  supersedes_id uuid REFERENCES notifications(id),
  superseded_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(user_id IS NOT NULL OR contact IS NOT NULL)
);
CREATE INDEX notifications_inbox ON notifications(user_id,created_at DESC) WHERE user_id IS NOT NULL AND superseded_at IS NULL;
CREATE INDEX notifications_entity ON notifications(entity_type,entity_id);
-- Exactly-once dispatch per (event, policy, recipient): replaying the outbox
-- can never duplicate a notification.
CREATE UNIQUE INDEX notifications_once ON notifications(policy_id,event_type,entity_id,coalesce(user_id::text,contact));

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK(channel IN ('in_app','web_push','sms','whatsapp','email')),
  -- unavailable: no provider configured. suppressed: user preference opted out
  -- of a non-mandatory category. Neither is ever reported as delivered.
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','unavailable','suppressed')),
  detail text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(notification_id,channel)
);
CREATE INDEX notification_deliveries_pending ON notification_deliveries(status,updated_at) WHERE status='pending';

-- Per-user channel choice for non-mandatory categories only. Mandatory
-- transactional alerts ignore this table by design.
CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id),
  category text NOT NULL CHECK(category IN ('critical','operational','marketing')),
  channel text NOT NULL CHECK(channel IN ('in_app','web_push','sms','whatsapp','email')),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,category,channel)
);

-- First/last-mile providers. LeRoutier does not resell these rides: a provider
-- is 'suggested_external' until a real integration exists, and the UI must say
-- so. launch_url is an official public entry point, never an invented deep link.
CREATE TABLE mobility_providers (
  id text PRIMARY KEY,
  name text NOT NULL,
  country char(2) NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]',
  integration_status text NOT NULL CHECK(integration_status IN ('suggested_external','integrated')),
  launch_url text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO mobility_providers(id,name,country,capabilities,integration_status,launch_url) VALUES
  ('gozem','Gozem','BJ','["first_mile","last_mile"]','suggested_external','https://gozem.co');

-- Handoff funnel. Deliberately stores no coordinates: measuring first-mile
-- demand must not become a location history of the passenger. A click is a
-- click — it never means a ride happened.
CREATE TABLE mobility_handoff_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  provider_id text REFERENCES mobility_providers(id),
  booking_id uuid REFERENCES bookings(id),
  leg text NOT NULL CHECK(leg IN ('first_mile','last_mile')),
  kind text NOT NULL CHECK(kind IN ('suggestion_viewed','handoff_clicked','directions_clicked','self_selected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobility_handoff_funnel ON mobility_handoff_events(provider_id,leg,kind,created_at);

-- Policies. Every event_type below is genuinely emitted by the domain; nothing
-- here describes a notification the system cannot actually raise.
INSERT INTO notification_policies(event_type,payload_match,audience,category,severity,template,channels,mandatory,entity_type) VALUES
  -- Passenger, booking and payment
  ('booking.held','{}','booking_passenger','operational','info','booking_created','["in_app"]',false,'booking'),
  ('payment.succeeded','{}','booking_passenger','critical','info','payment_succeeded','["in_app","sms"]',true,'booking'),
  ('payment.failed','{}','booking_passenger','critical','warning','payment_failed','["in_app","sms"]',true,'booking'),
  ('booking.confirmed','{}','booking_passenger','critical','info','ticket_ready','["in_app","sms"]',true,'booking'),
  ('booking.cancelled','{}','booking_passenger','critical','warning','booking_cancelled','["in_app","sms"]',true,'booking'),
  ('ticket.ready','{}','booking_passenger','critical','info','ticket_ready','["in_app"]',true,'booking'),
  ('first_mile.leave_soon','{}','booking_passenger','operational','info','first_mile_leave_soon','["in_app","sms"]',false,'booking'),
  ('boarding.starts_soon','{}','booking_passenger','operational','info','boarding_starts_soon','["in_app","sms"]',false,'booking'),
  ('service.rescheduled','{}','service_passengers','critical','warning','service_delayed','["in_app","sms"]',true,'service'),
  ('service.status','{"status":"cancelled"}','service_passengers','critical','urgent','service_cancelled','["in_app","sms"]',true,'service'),
  ('service.status','{"status":"disrupted"}','service_passengers','critical','warning','service_disrupted','["in_app","sms"]',true,'service'),
  ('service.boarding_point_changed','{}','service_passengers','critical','urgent','boarding_point_changed','["in_app","sms"]',true,'service'),
  ('booking.boarded','{}','booking_passenger','operational','info','passenger_boarded','["in_app"]',false,'booking'),
  ('booking.completed','{}','booking_passenger','operational','info','arrival_completed','["in_app"]',false,'booking'),
  -- Independent owner-driver: revenue and operations both belong to them.
  ('booking.confirmed','{}','service_driver_independent','operational','info','driver_new_booking','["in_app"]',false,'service'),
  ('booking.cancelled','{}','service_driver_independent','operational','info','driver_booking_cancelled','["in_app"]',false,'service'),
  ('operator_settlement.credited','{}','operator_owner','operational','info','settlement_credited','["in_app"]',false,'none'),
  ('operator_payout.paid','{}','operator_owner','critical','info','payout_paid','["in_app","sms"]',true,'payout'),
  ('operator_payout.failed','{}','operator_owner','critical','warning','payout_failed','["in_app","sms"]',true,'payout'),
  ('location.moderated','{}','point_proposer','operational','info','boarding_point_moderated','["in_app"]',false,'boarding_point'),
  -- Company driver: crew and service only. No settlement or revenue policy
  -- targets this audience — that separation is the product rule, not a filter.
  ('service.rescheduled','{}','service_driver_company','operational','warning','crew_service_rescheduled','["in_app"]',false,'service'),
  ('service.status','{"status":"cancelled"}','service_driver_company','operational','warning','crew_service_cancelled','["in_app"]',false,'service'),
  ('service.boarding_point_changed','{}','service_driver_company','operational','urgent','crew_boarding_point_changed','["in_app"]',false,'service'),
  ('incident.created','{}','service_driver_company','operational','urgent','crew_incident','["in_app"]',false,'incident'),
  ('service.recovery','{}','service_driver_company','operational','urgent','crew_recovery','["in_app"]',false,'service'),
  -- Convoyeur: manifest, walk-up and parcel handling.
  ('booking.walkup_sold','{}','service_convoyeur','operational','info','crew_walkup_recorded','["in_app"]',false,'service'),
  ('parcel.manifested','{}','service_convoyeur','operational','info','crew_parcel_to_load','["in_app"]',false,'parcel'),
  ('parcel.arrived','{}','service_convoyeur','operational','info','crew_parcel_to_unload','["in_app"]',false,'parcel'),
  ('parcel.exception','{}','service_convoyeur','operational','urgent','crew_parcel_exception','["in_app"]',false,'parcel'),
  ('service.advanced','{}','service_convoyeur','operational','info','crew_next_station','["in_app"]',false,'service'),
  -- Parcel sender and receiver. Templates never carry the pickup code.
  ('parcel.accepted','{}','parcel_sender','operational','info','parcel_accepted','["sms","whatsapp"]',false,'parcel'),
  ('parcel.loaded','{}','parcel_sender','operational','info','parcel_loaded','["sms"]',false,'parcel'),
  ('parcel.in_transit','{}','parcel_receiver','operational','info','parcel_in_transit','["sms"]',false,'parcel'),
  ('parcel.delayed','{}','parcel_sender','critical','warning','parcel_delayed','["sms"]',true,'parcel'),
  ('parcel.delayed','{}','parcel_receiver','critical','warning','parcel_delayed','["sms"]',true,'parcel'),
  ('parcel.eta_updated','{}','parcel_receiver','operational','info','parcel_eta_updated','["sms"]',false,'parcel'),
  ('parcel.arrived','{}','parcel_receiver','operational','info','parcel_arrived','["sms"]',false,'parcel'),
  ('parcel.ready_for_pickup','{}','parcel_receiver','critical','info','parcel_ready_for_pickup','["sms","whatsapp"]',true,'parcel'),
  ('parcel.exception','{}','parcel_sender','critical','urgent','parcel_exception','["sms"]',true,'parcel'),
  ('parcel.collected','{}','parcel_sender','critical','info','parcel_collected','["sms"]',true,'parcel'),
  ('parcel.collected','{}','parcel_receiver','operational','info','parcel_collected','["sms"]',false,'parcel'),
  -- Ops: exceptions only, never the normal flow.
  ('service.status','{"status":"cancelled"}','operator_ops','critical','urgent','ops_service_cancelled','["in_app"]',false,'service'),
  ('service.status','{"status":"disrupted"}','operator_ops','critical','warning','ops_service_disrupted','["in_app"]',false,'service'),
  ('incident.created','{}','operator_ops','critical','urgent','ops_incident','["in_app"]',false,'incident'),
  ('payment.anomaly','{}','operator_ops','critical','urgent','ops_payment_anomaly','["in_app"]',false,'none'),
  ('payout.anomaly','{}','platform_ops','critical','urgent','ops_payout_anomaly','["in_app"]',false,'payout'),
  ('operator_payout.failed','{}','operator_ops','critical','urgent','ops_payout_failed','["in_app"]',false,'payout'),
  ('parcel.lost','{}','operator_ops','critical','urgent','ops_parcel_lost','["in_app"]',false,'parcel'),
  ('parcel.damaged','{}','operator_ops','critical','urgent','ops_parcel_damaged','["in_app"]',false,'parcel'),
  ('parcel.exception','{}','operator_ops','critical','warning','ops_parcel_exception','["in_app"]',false,'parcel'),
  ('location.proposed','{}','platform_ops','operational','info','ops_point_pending_moderation','["in_app"]',false,'boarding_point'),
  ('service.boarding_point_changed','{}','operator_ops','operational','warning','ops_boarding_point_changed','["in_app"]',false,'service');
