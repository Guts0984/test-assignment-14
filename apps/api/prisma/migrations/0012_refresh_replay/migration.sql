-- A refresh whose response never reached the browser (a navigation cut it short) is re-sent with the same token a moment later.
-- The token that replaced it is kept, encrypted with a key derived from the server pepper, so that replay can be answered with
-- the very same successor for a short grace period instead of being treated as theft. After the grace period it is ignored.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS successor_enc text;
