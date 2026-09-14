CREATE TABLE operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  is_demo boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auth_subject text UNIQUE,
  display_name text NOT NULL, role text NOT NULL CHECK (role IN ('passenger','driver','ops')),
  operator_id uuid REFERENCES operators(id), is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE passenger_profiles (user_id uuid PRIMARY KEY REFERENCES users(id), phone text);
CREATE TABLE driver_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id), operator_id uuid NOT NULL REFERENCES operators(id),
  license_reference text NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_id uuid REFERENCES places(id),
  name text NOT NULL, kind text NOT NULL DEFAULT 'city', country_code char(2) NOT NULL DEFAULT 'BJ'
);
CREATE INDEX places_search ON places (lower(name) text_pattern_ops);
CREATE TABLE stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), place_id uuid NOT NULL REFERENCES places(id),
  name text NOT NULL, latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180)
);
CREATE INDEX stops_place ON stops(place_id);
CREATE TABLE routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operator_id uuid NOT NULL REFERENCES operators(id),
  name text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE route_stops (
  route_id uuid NOT NULL REFERENCES routes(id), sequence integer NOT NULL CHECK (sequence >= 0),
  stop_id uuid NOT NULL REFERENCES stops(id), fare_to_next integer NOT NULL DEFAULT 0 CHECK (fare_to_next >= 0),
  PRIMARY KEY(route_id, sequence), UNIQUE(route_id, stop_id)
);
CREATE FUNCTION validate_route_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer; highest integer; lowest integer;
BEGIN
  SELECT count(*), max(sequence), min(sequence) INTO n,highest,lowest FROM route_stops
    WHERE route_id=coalesce(NEW.route_id,OLD.route_id);
  IF n > 0 AND (n < 2 OR lowest <> 0 OR highest <> n-1) THEN
    RAISE EXCEPTION 'Route stops must form a contiguous ordered journey' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER route_order AFTER INSERT OR UPDATE OR DELETE ON route_stops
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_route_order();
CREATE VIEW route_segments AS SELECT route_id, sequence,
  stop_id AS origin_stop_id, lead(stop_id) OVER (PARTITION BY route_id ORDER BY sequence) AS destination_stop_id,
  fare_to_next FROM route_stops;
CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operator_id uuid NOT NULL REFERENCES operators(id),
  registration text NOT NULL UNIQUE, capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','retired')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), route_id uuid NOT NULL REFERENCES routes(id),
  operator_id uuid NOT NULL REFERENCES operators(id), departure_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','active','completed','cancelled','disrupted')),
  capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 100), current_sequence integer NOT NULL DEFAULT 0 CHECK(current_sequence>=0),
  is_demo boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_departure ON services(departure_at, status);
CREATE TABLE service_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_id uuid NOT NULL REFERENCES services(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id), driver_id uuid NOT NULL REFERENCES driver_profiles(user_id),
  assigned_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, CHECK(ended_at IS NULL OR ended_at>=assigned_at)
);
CREATE UNIQUE INDEX one_current_assignment ON service_assignments(service_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX one_vehicle_service ON service_assignments(vehicle_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX one_driver_service ON service_assignments(driver_id) WHERE ended_at IS NULL;
CREATE TABLE service_stops (
  service_id uuid NOT NULL REFERENCES services(id), sequence integer NOT NULL CHECK(sequence>=0),
  stop_id uuid NOT NULL REFERENCES stops(id), PRIMARY KEY(service_id,sequence), UNIQUE(service_id,stop_id)
);
CREATE TABLE service_segments (
  service_id uuid NOT NULL REFERENCES services(id), sequence integer NOT NULL,
  next_sequence integer GENERATED ALWAYS AS (sequence+1) STORED,
  fare_minor integer NOT NULL CHECK(fare_minor>=0), PRIMARY KEY(service_id,sequence),
  FOREIGN KEY(service_id,sequence) REFERENCES service_stops(service_id,sequence),
  FOREIGN KEY(service_id,next_sequence) REFERENCES service_stops(service_id,sequence)
);
CREATE TABLE service_seats (
  service_id uuid NOT NULL REFERENCES services(id), seat_number integer NOT NULL CHECK(seat_number>0),
  PRIMARY KEY(service_id,seat_number)
);
CREATE FUNCTION validate_seat_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seat_number > (SELECT capacity FROM services WHERE id=NEW.service_id FOR UPDATE) THEN
    RAISE EXCEPTION 'Seat exceeds service capacity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER seat_capacity BEFORE INSERT OR UPDATE ON service_seats FOR EACH ROW EXECUTE FUNCTION validate_seat_capacity();
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_id uuid NOT NULL REFERENCES services(id),
  passenger_id uuid NOT NULL REFERENCES passenger_profiles(user_id), origin_sequence integer NOT NULL,
  destination_sequence integer NOT NULL, seat_number integer NOT NULL,
  status text NOT NULL CHECK(status IN ('held','confirmed','boarded','completed','cancelled','expired')),
  amount_minor integer NOT NULL CHECK(amount_minor>=0), currency char(3) NOT NULL DEFAULT 'XOF' CHECK(currency='XOF'),
  expires_at timestamptz, idempotency_key text NOT NULL, request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(origin_sequence<destination_sequence), CHECK(status<>'held' OR expires_at IS NOT NULL),
  UNIQUE(passenger_id,idempotency_key), UNIQUE(id,service_id,seat_number),
  FOREIGN KEY(service_id,origin_sequence) REFERENCES service_stops(service_id,sequence),
  FOREIGN KEY(service_id,destination_sequence) REFERENCES service_stops(service_id,sequence),
  FOREIGN KEY(service_id,seat_number) REFERENCES service_seats(service_id,seat_number)
);
CREATE INDEX bookings_manifest ON bookings(service_id,status);
CREATE INDEX bookings_passenger ON bookings(passenger_id,created_at DESC);
CREATE INDEX held_expiry ON bookings(expires_at) WHERE status='held';
CREATE TABLE booking_passengers (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id), passenger_id uuid NOT NULL REFERENCES passenger_profiles(user_id)
);
-- One booking currently carries one passenger. Each occupied segment has one physical seat.
CREATE TABLE booking_segments (
  booking_id uuid NOT NULL, service_id uuid NOT NULL, seat_number integer NOT NULL, sequence integer NOT NULL,
  PRIMARY KEY(service_id,sequence,seat_number), UNIQUE(booking_id,sequence),
  FOREIGN KEY(booking_id,service_id,seat_number) REFERENCES bookings(id,service_id,seat_number),
  FOREIGN KEY(service_id,sequence) REFERENCES service_segments(service_id,sequence)
);
CREATE FUNCTION validate_occupation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bookings;
BEGIN
  SELECT * INTO b FROM bookings WHERE id=NEW.booking_id;
  IF b.status NOT IN ('held','confirmed','boarded') OR NEW.sequence < b.origin_sequence OR NEW.sequence >= b.destination_sequence THEN
    RAISE EXCEPTION 'Occupation outside booking journey' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER occupation_journey BEFORE INSERT OR UPDATE ON booking_segments FOR EACH ROW EXECUTE FUNCTION validate_occupation();
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES bookings(id),
  provider text NOT NULL, provider_reference text NOT NULL, amount_minor integer NOT NULL CHECK(amount_minor>=0),
  currency char(3) NOT NULL DEFAULT 'XOF' CHECK(currency='XOF'),
  status text NOT NULL CHECK(status IN ('pending','succeeded','failed','refunded')),
  idempotency_key text NOT NULL UNIQUE, request_fingerprint text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_reference)
);
CREATE INDEX payments_booking ON payments(booking_id);
CREATE TABLE boarding_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id),
  actor_id uuid NOT NULL REFERENCES users(id), stop_sequence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE alighting_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id),
  actor_id uuid NOT NULL REFERENCES users(id), stop_sequence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE VIEW manifests AS SELECT b.*,u.display_name AS passenger_name FROM bookings b JOIN users u ON u.id=b.passenger_id
  WHERE b.status IN ('confirmed','boarded','completed');
CREATE TABLE vehicle_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_id uuid NOT NULL REFERENCES services(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id), actor_id uuid NOT NULL REFERENCES users(id),
  latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(service_id,observed_at)
);
CREATE INDEX positions_latest ON vehicle_positions(service_id,observed_at DESC);
CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_id uuid NOT NULL REFERENCES services(id),
  reported_by uuid NOT NULL REFERENCES users(id), kind text NOT NULL CHECK(kind IN ('breakdown','delay','medical','accident','other')),
  severity text NOT NULL CHECK(severity IN ('low','medium','high')),
  description text NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','investigating','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_service ON incidents(service_id,status);
CREATE TABLE recovery_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_id uuid NOT NULL REFERENCES services(id),
  incident_id uuid NOT NULL REFERENCES incidents(id), previous_assignment_id uuid NOT NULL REFERENCES service_assignments(id),
  replacement_assignment_id uuid NOT NULL UNIQUE REFERENCES service_assignments(id),
  from_sequence integer NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(service_id,from_sequence) REFERENCES service_stops(service_id,sequence)
);
CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0)
);
CREATE INDEX pending_outbox ON outbox(created_at) WHERE delivered_at IS NULL;
CREATE TABLE api_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE request_limits (
  subject text NOT NULL, window_at timestamptz NOT NULL, requests integer NOT NULL CHECK(requests>0),
  PRIMARY KEY(subject,window_at)
);
