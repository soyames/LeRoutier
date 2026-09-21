-- Private credentials are returned only through the owning booking/parcel's
-- authorized endpoint. Hashes remain the scanner lookup keys. Retaining the
-- issued values prevents a preview from invalidating paper copies.
ALTER TABLE ticket_credentials ADD COLUMN token text;
ALTER TABLE ticket_credentials ADD COLUMN manual_code text;
ALTER TABLE parcel_labels ADD COLUMN token text;
-- Only a verified identity-provider claim can populate this address.
ALTER TABLE users ADD COLUMN notification_email text;

UPDATE notification_policies SET channels='["in_app","sms","email"]'
WHERE event_type='booking.confirmed' AND audience='booking_passenger';

-- Both parties can follow the whole custody journey, including without an app.
INSERT INTO notification_policies
  (event_type,payload_match,audience,category,severity,template,channels,mandatory,entity_type)
SELECT event_type,'{}',audience,'operational','info',template,'["sms","whatsapp"]',false,'parcel'
FROM (VALUES ('parcel.accepted','parcel_accepted'), ('parcel.loaded','parcel_loaded'),
  ('parcel.in_transit','parcel_in_transit'), ('parcel.arrived','parcel_arrived'),
  ('parcel.ready_for_pickup','parcel_ready_for_pickup'), ('parcel.cancelled','parcel_cancelled')) AS events(event_type,template)
CROSS JOIN (VALUES ('parcel_sender'),('parcel_receiver')) AS parties(audience)
ON CONFLICT DO NOTHING;
