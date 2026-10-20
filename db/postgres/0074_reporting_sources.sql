-- Reporting's sources in the application database (phase 14, step R1; docs/REPORTING_STEP1.md),
-- behind `reports_v1`. Additive. Reports never read these tables: the projection
-- (`analytics.project`) copies them, with conversation parts, into the analytical store.

-- Who the customer was when a conversation started: their contact's type and attributes,
-- written by the database itself so every way a conversation starts is covered.
CREATE TABLE conversation_snapshots (
 workspace_id text NOT NULL, conversation_id text NOT NULL, contact_id text, role text, profile jsonb NOT NULL DEFAULT '{}',
 -- No brand on conversations copied from the legacy store (D1).
 brand_id text, channel text, taken_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,conversation_id));
CREATE FUNCTION snapshot_conversation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO conversation_snapshots(workspace_id,conversation_id,contact_id,role,profile,brand_id,channel,taken_at)
 SELECT NEW.workspace_id,NEW.id,c.id,c.role,COALESCE(c.profile,'{}'),NEW.brand_id,NEW.channel,NEW.created_at
 FROM (SELECT 1) one
 LEFT JOIN identity_contact_mappings m ON m.workspace_id=NEW.workspace_id AND m.identity_id=NEW.primary_identity_id
 LEFT JOIN contacts c ON c.workspace_id=NEW.workspace_id AND c.id=m.contact_id
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER conversation_snapshot AFTER INSERT ON conversations FOR EACH ROW EXECUTE FUNCTION snapshot_conversation();

-- Each later change to a contact's type or attributes, as its own row (never an edit).
CREATE TABLE contact_changes (
 workspace_id text NOT NULL, id text NOT NULL, contact_id text NOT NULL, role text NOT NULL, profile jsonb NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,id));
CREATE INDEX contact_changes_time ON contact_changes(workspace_id,changed_at);
CREATE FUNCTION record_contact_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.role IS DISTINCT FROM OLD.role OR NEW.profile IS DISTINCT FROM OLD.profile THEN
  INSERT INTO contact_changes(workspace_id,id,contact_id,role,profile) VALUES(NEW.workspace_id,gen_random_uuid()::text,NEW.id,NEW.role,COALESCE(NEW.profile,'{}'));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contact_change AFTER UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION record_contact_change();
CREATE TRIGGER immutable_conversation_snapshots BEFORE UPDATE OR DELETE ON conversation_snapshots FOR EACH ROW EXECUTE FUNCTION reject_part_mutation();
CREATE TRIGGER immutable_contact_changes BEFORE UPDATE OR DELETE ON contact_changes FOR EACH ROW EXECUTE FUNCTION reject_part_mutation();
-- The projection finds what changed by this.
CREATE INDEX conversations_updated ON conversations(workspace_id,updated_at);

-- Conversations from before this migration: snapshotted now, from the contact as it is (the best
-- there is; their reports say "snapshot taken when reporting began").
INSERT INTO conversation_snapshots(workspace_id,conversation_id,contact_id,role,profile,brand_id,channel,taken_at)
SELECT v.workspace_id,v.id,c.id,c.role,COALESCE(c.profile,'{}'),v.brand_id,v.channel,now()
FROM conversations v
LEFT JOIN identity_contact_mappings m ON m.workspace_id=v.workspace_id AND m.identity_id=v.primary_identity_id
LEFT JOIN contacts c ON c.workspace_id=v.workspace_id AND c.id=m.contact_id
ON CONFLICT DO NOTHING;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['conversation_snapshots','contact_changes'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'reports_v1',false FROM workspace ON CONFLICT DO NOTHING;
