-- Passenger-facing vehicle description (e.g. "Toyota Hiace", "Autocar") plus
-- the structural test marker for the synthetic transport inventory. The TEST
-- dataset reuses the existing `is_demo` convention: demo/test operators,
-- users and services were already structurally flagged; vehicles now carry
-- the display model name and inherit their test status through the operator
-- or the service they are assigned to.
ALTER TABLE vehicles ADD COLUMN model text;

-- A bookings-level marker is deliberately NOT added: a booking's test status
-- is derived from its service (bookings -> services.is_demo), so there is
-- exactly one flag to maintain per service and no drift between them.
