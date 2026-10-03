-- Messenger settings, step M1: each brand's messenger is edited as a draft and published as a
-- numbered version. Publishing writes the live settings the messenger reads (brands.settings), so
-- the messenger's own path is unchanged; earlier versions are kept to restore. Additive.
CREATE TABLE messenger_drafts (
 workspace_id text NOT NULL, brand_id text NOT NULL, config jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), updated_by text,
 PRIMARY KEY(workspace_id,brand_id),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));
CREATE TABLE messenger_versions (
 workspace_id text NOT NULL, brand_id text NOT NULL, version integer NOT NULL CHECK(version>0),
 config jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), published_by text,
 PRIMARY KEY(workspace_id,brand_id,version),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));
CREATE FUNCTION keep_messenger_versions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Published messenger versions are kept as they were'; END $$;
CREATE TRIGGER immutable_messenger_versions BEFORE UPDATE OR DELETE ON messenger_versions FOR EACH ROW EXECUTE FUNCTION keep_messenger_versions();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['messenger_drafts','messenger_versions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'messenger_v3',false FROM workspace ON CONFLICT DO NOTHING;
