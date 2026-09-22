-- What a coach actually offers, declared by the operator who runs it.
--
-- Stored as a set rather than a column per feature: the list of things an
-- intercity coach in Benin advertises changes with the market, and each new
-- one should not be a migration. The allowlist is enforced in the domain layer
-- against ONE constant, so a value that reaches this column is always a value
-- the UI knows how to label — an amenity nobody can render is worse than none.
--
-- Nothing here is inferred. A vehicle claims air conditioning because its
-- operator said so, and a passenger sees the claim attributed to the operator,
-- not as a LeRoutier guarantee.
ALTER TABLE vehicles ADD COLUMN amenities text[] NOT NULL DEFAULT '{}';

-- Searching "climatisé" is an array containment test, so it is worth an index.
CREATE INDEX vehicles_amenities ON vehicles USING gin (amenities);
