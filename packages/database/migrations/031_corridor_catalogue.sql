-- Known corridors, and a place to board in every commune.
--
-- THE DISTINCTION THIS TABLE EXISTS TO PROTECT:
--
--   A corridor is a road people travel. It says nothing about whether anybody
--   is driving it today. It is not a route (which belongs to one operator and
--   carries that operator's fares) and it is certainly not a service (which is
--   a real departure with a vehicle, a driver and seats). A passenger never
--   sees a corridor; only published services reach search.
--
-- Without this, an operator building their first line had to invent every stop
-- by hand — name, latitude and longitude, one at a time — before they could
-- describe a journey that thousands of people already make every week. Thirteen
-- stops existed for seventy-seven communes.

-- ---------------------------------------------------------------- stops ----
-- One boarding stop per commune, named after the commune and placed at the
-- commune's own coordinates, which the geography migration already carries.
--
-- Deliberately commune-level. LeRoutier does not know where the gare routière
-- in Bantè is, and writing a precise address it cannot verify would be
-- inventing data an operator would then be blamed for. The exact spot is a
-- boarding_point: proposed by the people who actually stand there, and marked
-- unverified until somebody checks it.
--
-- The `NOT s.is_demo` matters and was found by the assertion at the bottom of
-- this file. A commune whose only stop came from the synthetic TEST inventory
-- looked served, so no real stop was created — and then the corridor below,
-- which correctly refuses to reference TEST inventory, had nothing to point
-- at. Synthetic data must never stand in for the real thing, in either
-- direction.
INSERT INTO stops(place_id,name,latitude,longitude)
SELECT p.id,p.name,p.latitude,p.longitude
FROM places p
WHERE p.kind='city' AND p.source='benin-geography'
  AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM stops s WHERE s.place_id=p.id AND NOT s.is_demo);

-- ------------------------------------------------------------ corridors ----
CREATE TABLE corridors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK(length(name) BETWEEN 3 AND 200),
  -- What a traveller would call it, so the catalogue is searchable in the
  -- words people use rather than in the words we filed it under.
  description text,
  -- Cross-border readiness. A corridor may span countries; that is a fact
  -- about the road. Whether an operator may LEGALLY run it is their transport
  -- authorization's business and is never inferred from this column.
  country_codes char(2)[] NOT NULL DEFAULT '{BJ}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE corridor_stops (
  corridor_id uuid NOT NULL REFERENCES corridors(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK(sequence >= 0),
  stop_id uuid NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  PRIMARY KEY (corridor_id,sequence),
  UNIQUE (corridor_id,stop_id)
);
CREATE INDEX corridor_stops_stop ON corridor_stops(stop_id);

-- The corridors themselves. Every intermediate commune below is ordered by the
-- coordinates already stored in places, so the sequence is checkable against
-- this repository's own geography rather than taken on trust. No road numbers
-- are claimed: a corridor is named by where it goes.
INSERT INTO corridors(name,description,country_codes) VALUES
  ('Cotonou → Parakou','Axe central par Bohicon, Dassa-Zoumè et Savè.','{BJ}'),
  ('Cotonou → Malanville','Axe nord complet, jusqu’à la frontière du Niger.','{BJ}'),
  ('Cotonou → Natitingou','Axe nord-ouest par Bohicon, Savalou et Djougou.','{BJ}'),
  ('Cotonou → Lokossa','Par Ouidah et Comè.','{BJ}'),
  ('Cotonou → Hillacondji (frontière du Togo)','Axe côtier par Ouidah et Grand-Popo.','{BJ,TG}'),
  ('Cotonou → Porto-Novo','Par Sèmè-Kpodji.','{BJ}'),
  -- Named after the border COMMUNE, not after the border post inside it.
  -- Kraké is a village; there is no commune-level stop for it, and writing one
  -- would be inventing a location an operator would be sent to.
  ('Cotonou → Sèmè-Kpodji (frontière du Nigéria)','Axe est, jusqu’à la commune frontalière.','{BJ,NG}'),
  ('Cotonou → Abomey','Par Abomey-Calavi, Allada et Bohicon.','{BJ}'),
  ('Parakou → Malanville','Section nord seule, par N’Dali, Bembèrèkè et Kandi.','{BJ}'),
  ('Parakou → Natitingou','Par Djougou.','{BJ}');

-- Stop sequences, resolved against the geography above by name OR by one of
-- its recorded aliases. Matching on the exact name alone is what made an
-- earlier version of this file silently shorten two corridors: "Sèmè-Podji" is
-- filed as "Sèmè-Kpodji", and "N'Dali" was written with a typographic
-- apostrophe. Each produced a corridor that was still valid, still non-empty,
-- and quietly missing a town.
CREATE TEMPORARY TABLE corridor_plan(name text,communes text[]) ON COMMIT DROP;
INSERT INTO corridor_plan VALUES
  ('Cotonou → Parakou', ARRAY['Cotonou','Allada','Bohicon','Dassa-Zoumè','Savè','Tchaourou','Parakou']),
  ('Cotonou → Malanville', ARRAY['Cotonou','Bohicon','Dassa-Zoumè','Savè','Tchaourou','Parakou','N''Dali','Bembèrèkè','Kandi','Malanville']),
  ('Cotonou → Natitingou', ARRAY['Cotonou','Bohicon','Savalou','Djougou','Natitingou']),
  ('Cotonou → Lokossa', ARRAY['Cotonou','Ouidah','Comè','Lokossa']),
  ('Cotonou → Hillacondji (frontière du Togo)', ARRAY['Cotonou','Ouidah','Comè','Grand-Popo']),
  ('Cotonou → Porto-Novo', ARRAY['Cotonou','Sèmè-Kpodji','Porto-Novo']),
  ('Cotonou → Sèmè-Kpodji (frontière du Nigéria)', ARRAY['Cotonou','Porto-Novo','Sèmè-Kpodji']),
  ('Cotonou → Abomey', ARRAY['Cotonou','Abomey-Calavi','Allada','Bohicon','Abomey']),
  ('Parakou → Malanville', ARRAY['Parakou','N''Dali','Bembèrèkè','Kandi','Malanville']),
  ('Parakou → Natitingou', ARRAY['Parakou','Djougou','Natitingou']);

INSERT INTO corridor_stops(corridor_id,sequence,stop_id)
SELECT c.id,entry.sequence,s.id
FROM corridor_plan plan
CROSS JOIN LATERAL unnest(plan.communes) WITH ORDINALITY AS entry(commune,sequence)
JOIN corridors c ON c.name=plan.name
JOIN places p ON p.kind='city' AND p.source='benin-geography'
  AND (p.name=entry.commune OR p.aliases ? entry.commune)
JOIN LATERAL (SELECT st.id FROM stops st WHERE st.place_id=p.id AND NOT st.is_demo ORDER BY st.name LIMIT 1) s ON true;

-- Every corridor must have exactly the towns it was written with. A corridor
-- that is merely non-empty can still be missing a town, which is worse than
-- having no corridor at all: an operator adopts it, publishes it, and finds
-- out at a roadside that the stop passengers expect is not on their line.
DO $$
DECLARE broken text;
BEGIN
  SELECT string_agg(format('%s (%s of %s)',plan.name,found.n,array_length(plan.communes,1)),', ')
    INTO broken
  FROM corridor_plan plan
  JOIN corridors c ON c.name=plan.name
  CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM corridor_stops cs WHERE cs.corridor_id=c.id) found
  WHERE found.n <> array_length(plan.communes,1);
  IF broken IS NOT NULL THEN
    RAISE EXCEPTION 'Corridors did not resolve every commune: %', broken;
  END IF;
END $$;
