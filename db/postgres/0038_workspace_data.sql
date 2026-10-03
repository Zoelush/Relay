-- Settings (S2b): tags are archived, never deleted. An archived tag stays on the conversations
-- that have it (history and reports keep its name) and can't be added again. Additive.
ALTER TABLE tags ADD COLUMN archived_at timestamptz;
CREATE FUNCTION keep_tags() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Tags must be archived, never deleted'; END $$;
CREATE TRIGGER archive_only_tags BEFORE DELETE ON tags FOR EACH ROW EXECUTE FUNCTION keep_tags();
