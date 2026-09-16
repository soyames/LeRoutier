-- Real road geometry for routes, and richer vehicle GPS.
--
-- A route is ordered stops; the road between them comes from a routing engine
-- and is stored so a passenger opening a map never triggers a routing call.
-- Geometry is a GeoJSON LineString coordinate array in plain jsonb: every
-- calculation LeRoutier performs (projection, progress, off-route, ETA) runs in
-- JavaScript against the same array the map renders, so PostGIS would add an
-- extension and an operational dependency for no capability we use.

CREATE TABLE route_geometries (
  route_id uuid PRIMARY KEY REFERENCES routes(id) ON DELETE CASCADE,
  -- GeoJSON LineString coordinates: [[lon,lat], …] in route order.
  coordinates jsonb NOT NULL,
  distance_m integer NOT NULL CHECK(distance_m > 0),
  -- Which engine produced this, so geometry can be re-derived or audited.
  provider text NOT NULL,
  -- Hash of the ordered stop coordinates used. When the stops move or are
  -- reordered the hash changes and the geometry is known to be out of date.
  input_hash text NOT NULL,
  -- The stop sequence this geometry was built from, for the same reason.
  stop_count integer NOT NULL CHECK(stop_count >= 2),
  generated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(jsonb_typeof(coordinates) = 'array')
);

-- Why a generation attempt failed, for Ops support. Safe diagnostics only:
-- a reason code and a short message, never a provider payload or a URL.
CREATE TABLE route_geometry_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  reason text NOT NULL,
  detail text NOT NULL DEFAULT '',
  attempted_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX route_geometry_failures_route ON route_geometry_failures(route_id, created_at DESC);

-- GPS quality and provenance. All nullable: a device that reports none of them
-- still produces a usable position, and nothing here is ever invented.
ALTER TABLE vehicle_positions ADD COLUMN accuracy_m double precision
  CHECK(accuracy_m IS NULL OR (accuracy_m >= 0 AND accuracy_m <= 100000));
ALTER TABLE vehicle_positions ADD COLUMN speed_mps double precision
  CHECK(speed_mps IS NULL OR (speed_mps >= 0 AND speed_mps <= 100));
ALTER TABLE vehicle_positions ADD COLUMN heading_deg double precision
  CHECK(heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360));
-- Provider-neutral: the PWA today, dedicated trackers or fleet integrations
-- later, without reshaping the model around one vendor.
ALTER TABLE vehicle_positions ADD COLUMN source text NOT NULL DEFAULT 'pwa_device'
  CHECK(source IN ('pwa_device','dedicated_tracker','fleet_integration'));
