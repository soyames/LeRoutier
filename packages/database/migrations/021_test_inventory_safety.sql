-- is_demo=true denotes controlled TEST/synthetic transport data. Reuse the
-- existing convention on inventory that previously inherited it implicitly.
ALTER TABLE vehicles ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE routes ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE stops ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
UPDATE vehicles v SET is_demo=true FROM operators o WHERE o.id=v.operator_id AND o.is_demo;
UPDATE routes r SET is_demo=true FROM operators o WHERE o.id=r.operator_id AND o.is_demo;
