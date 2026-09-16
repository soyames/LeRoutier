# Maps, road routing and vehicle tracking

How LeRoutier shows where a bus actually is, on the road it actually takes.

Three rules govern everything below:

- **No fake routes.** A straight line between two cities is never drawn as if it
  were a road. Without road geometry, the screen shows the stops and says the
  road route is unavailable.
- **No fake live.** "Suivi en direct" appears only while LeRoutier is receiving
  recent GPS. Otherwise: "Dernière position connue" or "Suivi indisponible".
- **No fake ETA.** An arrival estimate is produced only from inputs that exist,
  carries an explicit confidence, and degrades when the signal does.

## Benin geography — verified, not assumed

The basemap is OpenStreetMap. No boundary polygon is bundled: OSM tiles already
render Benin's real roads, towns and borders, and every coordinate is genuine
WGS84 lat/lon — the same space GPS fixes arrive in.

Ardoise (the sibling project) has Benin department and commune boundaries, but
in `beninGeo.js` they are **SVG viewBox coordinates** projected from lon/lat for
an administrative diagram. They are unusable for GPS. What was reused from
Ardoise is the *pattern*, not the data: a single `map-tiles.js` module, Leaflet
+ React-Leaflet, OSM light / CARTO dark, key-free with attribution carried.

**Coverage was checked against the official network**, not taken on trust.
Benin's national roads are 7 interstate routes (RNIE 1–7) and ~10 national
routes (RN 1–10) per the French Wikipedia list and AARoads — both of which,
notably, render their own Benin maps from OpenStreetMap.

Queried directly from Overpass on 2026-09-16:

| Check | Result |
| --- | --- |
| Road route relations in Benin | **67**, of which **33** are RN/RNIE |
| RNIE relations present | RNIE 1, 1B, **2**, 4, 5, 6 |
| RNIE 2 geometry (Cotonou–Savé–Parakou–Malanville) | **10 102 vertices**, **831 km** measured |
| RNIE 2 latitude span | 6.39 → 11.88 (Cotonou 6.36 → Malanville 11.87) |

RNIE 2 is LeRoutier's pilot corridor. 831 km of traced geometry against a
nominal official length of 750 km — and against roughly 615 km as the crow flies
— is a road being followed, not a line being drawn. That is the difference this
whole feature exists to preserve.

`RNIE 3` and `RNIE 7` returned no relation matching a `ref` tag in that query.
Cross-checking the OSM-derived directory `rues-benin.openalfa.com` shows **RNIE 3
is present in OSM**, carrying its reference in the name rather than the `ref`
tag — an OSM tagging inconsistency, not a missing road. That directory also
lists RN routes up to RN 38, i.e. broader coverage than the official summary
lists.

One operational caveat worth carrying into the ETA model: AARoads records that
Benin's network is mainly unpaved, with the coastal road and the north–south
Cotonou–north axis being the paved exceptions. The paved axis *is* RNIE 2. A
single default road speed is therefore defensible for the pilot corridor and
should **not** be assumed for unpaved branches.

## Mapping stack

| | |
| --- | --- |
| Renderer | Leaflet 1.9 + React-Leaflet 5 |
| Tiles | OSM raster (light), CARTO `dark_all` (dark) — both key-free |
| Attribution | Carried in `map-tiles.js`, rendered by Leaflet's control |
| Viewport | Benin bounds; panning beyond them stays possible for border roads |
| Loading | `React.lazy` — Leaflet ships as its own ~46 kB gzipped chunk and is fetched only when a map is opened |

Tile URLs exist in exactly one file. Moving to a hosted or self-run tile service
is a change to `TILE_STYLES` alone.

**Scale note:** public OSM tile infrastructure is acceptable for a controlled
pilot and must not be leaned on at production volume. Replacing it is the
single-file change above.

## Routing

`packages/routing` is a provider-neutral adapter. The shipped driver speaks the
**OSRM HTTP API**, which OSRM itself, a self-hosted instance and several
OSRM-compatible services all expose.

**No default endpoint ships.** The public OSRM and Valhalla demo servers forbid
production use, so an operator points `ROUTING_URL` at an engine they are
entitled to run or use. Until then routing is simply unavailable and every
surface says so — it never falls back to a straight line.

| Variable | Meaning |
| --- | --- |
| `ROUTING_URL` | Base URL of an OSRM-compatible engine. Unset ⇒ unavailable. |
| `ROUTING_PROVIDER` | Label stored with generated geometry (default `osrm`). |
| `ROUTING_API_KEY` | Optional bearer token, server-side only. |
| `ROUTING_TIMEOUT_MS` | Default 15 000. |

Self-hosting OSRM with a Benin OSM extract is the recommended pilot path: the
country extract is small, the data is the same OSM network verified above, and
it removes both the quota and the terms-of-use question.

### Geometry lifecycle

Generated when Ops asks (`POST /api/v1/routes/:id/geometry`), stored once, and
**never** recalculated for a passenger request.

Stored per route: the GeoJSON `LineString` coordinates, road distance, provider,
generation time, stop count, and a hash of the ordered stop coordinates. When
stops move or are reordered the hash no longer matches and the geometry is
reported `stale` — still shown, but known to be out of date.

Storage is plain `jsonb`. **PostGIS was deliberately not added**: every
calculation LeRoutier performs — projection, progress, off-route, ETA — runs in
JavaScript against the same coordinate array the map renders, so an extension
and an operational dependency would buy no capability we use.

### Failure

Failures are recorded as a safe reason code (`not_configured`,
`missing_coordinates`, `no_route`, `provider_error`, `provider_timeout`,
`malformed_geometry`) with a short message, for Ops. No provider payload, URL or
stack trace is stored or shown. The route stays editable and usable; only its
road line is missing, and Ops can retry.

## GPS

Positions are provider-neutral (`pwa_device`, `dedicated_tracker`,
`fleet_integration`). Today the PWA device flow is implemented; the model is
shaped so a dedicated tracker or fleet integration can post through the same
authenticated endpoint without reshaping anything.

**Authorisation.** Only crew assigned to that service may publish, enforced by
the existing service authorisation. Passengers cannot. Cross-operator submission
is refused. A closed service (completed/cancelled) rejects positions, and a
service with no active vehicle assignment is refused rather than erroring.

**Update policy** (`shouldPublishPosition`, configurable): publish when the
vehicle has moved a meaningful distance **or** an upper time interval has
elapsed — so a parked bus does not drain a phone and a moving one is not
under-reported. A fix whose own accuracy is worse than ~200 m is discarded.

**Offline.** Unsent fixes are buffered locally, bounded to 40 entries and 30
minutes, replayed oldest-first with their original `observedAt`. The server
refuses anything not newer than what it holds, so replay cannot duplicate.

**Browser limitation, stated plainly.** A web app receives positions only while
its page is alive. Android may suspend a backgrounded tab; iOS Safari stops
geolocation when not foregrounded. **There is no reliable background
geolocation on the web platform.** Continuous tracking means the crew device
stays on that page. A dedicated tracker or native app would remove the
constraint — neither is claimed or implemented.

### Freshness

Central thresholds (`FRESHNESS`), used by every surface:

| State | Age | Shown as |
| --- | --- | --- |
| `live` | ≤ 90 s | Suivi en direct |
| `delayed` | ≤ 5 min | Signal GPS retardé |
| `stale` | ≤ 30 min | Dernière position connue |
| `unavailable` | older / none | Suivi indisponible |

## Progress and next stop

Given stored geometry and a GPS fix, the vehicle is projected onto the line:
distance along, distance remaining, fraction, and perpendicular deviation.

- **Monotonic.** A noisy sample that projects backwards cannot rewind progress,
  so a passenger's remaining distance does not jump around.
- **Next stop is ahead on the route**, not merely nearest — the nearest stop is
  frequently the one already behind the bus. Stops are projected onto the line
  in order, and an operational arrival recorded by crew always outranks the GPS
  guess.
- **GPS never overwrites operations.** Passing a station on GPS does not board
  anyone or mark an arrival; it is informational.

### Off route

Confirmed only by **consecutive** observations beyond tolerance (default 250 m,
3 samples). A sample whose own accuracy circle is wider than its deviation
proves nothing and is excluded. Surfaced to Ops; not to passengers, who should
not be alarmed by a short detour.

## ETA

`estimateArrival` uses: remaining road distance, recent GPS movement (median
speed across the last fixes, implausible jumps discarded), and the operator's
schedule. It does **not** use traffic conditions, historical segment times or
any third-party prediction — LeRoutier has none of those, and none is implied.

| Confidence | When |
| --- | --- |
| `live` | recent GPS **and** usable measured movement |
| `estimated` | position known, movement inferred from the route default speed |
| `scheduled` | no usable GPS; the timetable is all there is |
| `unavailable` | not enough to say anything |

Results are rounded to five minutes: the inputs do not support minute precision,
and "14:24:37" would imply an accuracy this system does not have. The estimate
targets the **passenger's own alighting stop**, not always the end of the line.

## API

| Route | Who |
| --- | --- |
| `GET /api/v1/journeys/:bookingId/tracking` | the passenger, for their own booking with an active ticket |
| `GET /api/v1/services/:id/tracking` | crew and Ops for that service |
| `GET /api/v1/ops/fleet-tracking` | Ops, scoped to their own operator |
| `POST /api/v1/services/:id/positions` | assigned crew only |
| `GET/POST /api/v1/routes/:id/geometry` | read / Ops regenerate |

Exact live coordinates are **not** public. Public parcel tracking keeps its
existing coarse, privacy-preserving projection and is unchanged by this work.

## Live updates

Polling, every 20 s while the tracking screen is open, paused when the tab is
hidden. The API runs as serverless functions on Vercel, where a long-lived
socket per passenger has no natural home; for a bus, a short poll is sufficient
and far cheaper. The transport is isolated in one component, so moving to SSE or
WebSockets later is a contained change.

## Testing

Geometry and ETA are covered by deterministic unit tests against fixed fixtures
— **no test depends on a routing provider or a tile server being online**.
Routing behaviour in the database suite runs against an injected fake engine.

## Remaining external dependency

A routing engine LeRoutier is entitled to use — self-hosted OSRM with a Benin
extract, or a commercial OSRM-compatible service. Until one is configured,
routes have no road geometry, the map shows stops only, and progress and
distance-based ETA are unavailable. Everything else — GPS capture, freshness,
next stop from the operational sequence, schedule-based arrival — works without
it.
