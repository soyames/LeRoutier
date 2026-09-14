CREATE FUNCTION occupation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bookings; allocated integer;
BEGIN
  IF TG_TABLE_NAME='bookings' THEN SELECT * INTO b FROM bookings WHERE id=coalesce(NEW.id,OLD.id);
  ELSE SELECT * INTO b FROM bookings WHERE id=coalesce(NEW.booking_id,OLD.booking_id); END IF;
  IF b.id IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO allocated FROM booking_segments WHERE booking_id=b.id;
  IF (b.status IN ('held','confirmed','boarded') AND allocated<>b.destination_sequence-b.origin_sequence)
    OR (b.status IN ('cancelled','expired','completed') AND allocated<>0) THEN
    RAISE EXCEPTION 'Booking segment allocation is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER complete_booking AFTER INSERT OR UPDATE ON bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occupation_complete();
CREATE CONSTRAINT TRIGGER complete_segments AFTER INSERT OR UPDATE OR DELETE ON booking_segments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occupation_complete();
CREATE FUNCTION immutable_service_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='services' THEN
    IF NEW.capacity <> OLD.capacity OR NEW.route_id <> OLD.route_id OR NEW.operator_id <> OLD.operator_id THEN
      RAISE EXCEPTION 'Service plan is immutable; create a new service' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM bookings WHERE service_id=OLD.service_id) THEN
    RAISE EXCEPTION 'Booked service stops and fares are immutable' USING ERRCODE='23514';
  END IF;
  RETURN coalesce(NEW,OLD);
END $$;
CREATE TRIGGER immutable_service BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION immutable_service_plan();
CREATE TRIGGER immutable_stops BEFORE UPDATE OR DELETE ON service_stops FOR EACH ROW EXECUTE FUNCTION immutable_service_plan();
CREATE TRIGGER immutable_fares BEFORE UPDATE OR DELETE ON service_segments FOR EACH ROW EXECUTE FUNCTION immutable_service_plan();
