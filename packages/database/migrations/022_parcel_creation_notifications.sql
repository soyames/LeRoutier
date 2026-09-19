-- Send the sender and receiver an honest acknowledgement when an order is
-- created; later custody changes use the existing parcel lifecycle policies.
INSERT INTO notification_policies
  (event_type,payload_match,audience,category,severity,template,channels,mandatory,entity_type)
VALUES
  ('parcel.created','{}','parcel_sender','operational','info','parcel_created','["sms"]',false,'parcel'),
  ('parcel.created','{}','parcel_receiver','operational','info','parcel_created','["sms"]',false,'parcel')
ON CONFLICT DO NOTHING;
