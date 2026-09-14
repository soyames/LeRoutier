CREATE OR REPLACE VIEW route_segments AS SELECT route_id,sequence,origin_stop_id,destination_stop_id,fare_to_next
FROM (SELECT route_id,sequence,stop_id AS origin_stop_id,
  lead(stop_id) OVER(PARTITION BY route_id ORDER BY sequence) AS destination_stop_id,fare_to_next FROM route_stops) ordered
WHERE destination_stop_id IS NOT NULL;
CREATE FUNCTION assignment_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s services; v vehicles; d driver_profiles;
BEGIN
  SELECT * INTO s FROM services WHERE id=NEW.service_id;
  SELECT * INTO v FROM vehicles WHERE id=NEW.vehicle_id;
  SELECT * INTO d FROM driver_profiles WHERE user_id=NEW.driver_id;
  IF s.operator_id<>v.operator_id OR s.operator_id<>d.operator_id OR v.capacity<s.capacity OR NOT d.active OR v.status<>'active' THEN
    RAISE EXCEPTION 'Assignment does not match service operator or capacity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER valid_assignment BEFORE INSERT ON service_assignments FOR EACH ROW EXECUTE FUNCTION assignment_integrity();
CREATE FUNCTION service_route_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operator_id<>(SELECT operator_id FROM routes WHERE id=NEW.route_id) THEN
    RAISE EXCEPTION 'Service operator must match route' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER valid_service_route BEFORE INSERT ON services FOR EACH ROW EXECUTE FUNCTION service_route_integrity();
