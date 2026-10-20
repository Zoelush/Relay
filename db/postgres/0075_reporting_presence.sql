-- Reporting (phase 14, step R2; docs/REPORTING_STEP2.md): teammates' presence over time, for
-- "conversations per teammate per hour". Additive. A trigger records each change (and what it
-- was before), so every way presence changes is covered; reports read the analytical store's copy.
CREATE TABLE teammate_presence_changes (
 workspace_id text NOT NULL, id text NOT NULL, teammate_id text NOT NULL, from_presence text NOT NULL, to_presence text NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,id));
CREATE INDEX teammate_presence_changes_time ON teammate_presence_changes(workspace_id,changed_at);
CREATE FUNCTION record_presence_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.presence IS DISTINCT FROM OLD.presence THEN
  INSERT INTO teammate_presence_changes(workspace_id,id,teammate_id,from_presence,to_presence) VALUES(NEW.workspace_id,gen_random_uuid()::text,NEW.id,OLD.presence,NEW.presence);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER teammate_presence_change AFTER UPDATE ON teammates FOR EACH ROW EXECUTE FUNCTION record_presence_change();
CREATE TRIGGER immutable_presence_changes BEFORE UPDATE OR DELETE ON teammate_presence_changes FOR EACH ROW EXECUTE FUNCTION reject_part_mutation();
ALTER TABLE teammate_presence_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE teammate_presence_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON teammate_presence_changes USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
