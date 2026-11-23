-- The paired test workspace, T3a (docs/TEST_WORKSPACE_STEP5.md): an app's manifest as published
-- versions, installations pinned to one, and the sandbox. Additive.
--
-- The oauth_apps row stays the developer's draft. A version is that draft as published, kept
-- exactly as it was: the trigger below refuses every change except recording its release, once.
-- An installation records the version a manager consented to. Which version it runs is worked
-- out when it is read (server/app-versions.ts), so no workspace ever writes another's rows.
CREATE TABLE oauth_app_versions (
 workspace_id text NOT NULL REFERENCES workspace(id),
 app_id text NOT NULL,
 version int NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=300),
 redirect_uris text[] NOT NULL CHECK(cardinality(redirect_uris) BETWEEN 1 AND 10),
 scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 30),
 canvas_url text,
 canvas_placements text[] NOT NULL DEFAULT '{}',
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=500),
 published_at timestamptz NOT NULL DEFAULT now(), published_by text,
 released_at timestamptz, released_by text,
 PRIMARY KEY(workspace_id,app_id,version),
 FOREIGN KEY(workspace_id,app_id) REFERENCES oauth_apps(workspace_id,id));
ALTER TABLE oauth_app_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_app_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON oauth_app_versions USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE FUNCTION oauth_app_versions_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'App versions are kept as they were published'; END IF;
 IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
  AND (to_jsonb(NEW) - 'released_at' - 'released_by') = (to_jsonb(OLD) - 'released_at' - 'released_by') THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'App versions are kept as they were published';
END $$;
CREATE TRIGGER kept BEFORE UPDATE OR DELETE ON oauth_app_versions FOR EACH ROW EXECUTE FUNCTION oauth_app_versions_kept();
-- Publishing is audited by the row it writes. Releasing is recorded explicitly (app_version.released).
CREATE TRIGGER audit AFTER INSERT ON oauth_app_versions FOR EACH ROW
 EXECUTE FUNCTION audit_row('app_version','app','app_id,version','name','redirect_uris,canvas_placements,canvas_url,released_at,released_by,published_at,published_by','published');

-- The version an installation's manager consented to.
ALTER TABLE oauth_grants ADD COLUMN app_version int;

-- Every app that already existed becomes version 1, released, and every installation is pinned to
-- it, so nothing that worked stops working.
INSERT INTO oauth_app_versions(workspace_id,app_id,version,name,description,redirect_uris,scopes,canvas_url,canvas_placements,published_at,published_by,released_at,released_by)
 SELECT workspace_id,id,1,name,description,redirect_uris,scopes,canvas_url,canvas_placements,created_at,created_by,created_at,created_by FROM oauth_apps
 ON CONFLICT DO NOTHING;
UPDATE oauth_grants SET app_version=1 WHERE app_version IS NULL;
