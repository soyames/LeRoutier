-- Which provider a recommendation actually came from, when it was not the one
-- configured. `provider` already records who answered; this records who was
-- asked first and could not, so "Gemini was out of quota all afternoon" is a
-- question the usage view can answer instead of an impression.
--
-- NULL means no fallback happened, which is the overwhelmingly common case and
-- the reason this is a nullable column rather than a second table.
ALTER TABLE agent_model_calls ADD COLUMN fallback_from text;

-- Fallback rate per day, without scanning the whole table.
CREATE INDEX agent_model_calls_fallback ON agent_model_calls(day) WHERE fallback_from IS NOT NULL;
