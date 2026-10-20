-- OAuth apps (phase 15, step D4; docs/DEVELOPER_PLATFORM_STEP4.md), behind `developer_api_v1`.
-- Additive. An app is registered in its developer's workspace, and installed into a workspace by
-- someone who manages it. Its client id, codes and tokens carry their workspace, so each is looked
-- up inside its own workspace's row-level security, never by a search across workspaces.
CREATE TABLE oauth_apps (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=300),
 redirect_uris text[] NOT NULL CHECK(cardinality(redirect_uris) BETWEEN 1 AND 10),
 scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 30),
 secret_hash text NOT NULL, secret_last_four text NOT NULL,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 archived_at timestamptz,
 PRIMARY KEY(workspace_id,id));
-- An installation: an app allowed into this workspace, by whom, with which scopes.
CREATE TABLE oauth_grants (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 app_workspace_id text NOT NULL, app_id text NOT NULL, app_name text NOT NULL,
 teammate_id text NOT NULL, scopes text[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, revoked_reason text,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id));
CREATE UNIQUE INDEX oauth_grants_live ON oauth_grants(workspace_id,app_workspace_id,app_id) WHERE revoked_at IS NULL;
-- An authorization code: used once, within 10 minutes, with its PKCE challenge and redirect.
CREATE TABLE oauth_codes (
 workspace_id text NOT NULL, code_hash text NOT NULL, grant_id text NOT NULL,
 redirect_uri text NOT NULL, code_challenge text NOT NULL,
 expires_at timestamptz NOT NULL, used_at timestamptz,
 PRIMARY KEY(workspace_id,code_hash));
-- Refresh tokens rotate: each is used once; a used one coming back revokes the installation.
CREATE TABLE oauth_refresh_tokens (
 workspace_id text NOT NULL, token_hash text NOT NULL, grant_id text NOT NULL,
 expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,token_hash));
CREATE INDEX oauth_refresh_grant ON oauth_refresh_tokens(workspace_id,grant_id);
-- An app's access tokens are API tokens of the installing teammate, for an hour, tied to the grant.
ALTER TABLE api_tokens ADD COLUMN grant_id text;
ALTER TABLE api_tokens ADD COLUMN expires_at timestamptz;
CREATE INDEX api_tokens_grant ON api_tokens(workspace_id,grant_id) WHERE grant_id IS NOT NULL;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['oauth_apps','oauth_grants','oauth_codes','oauth_refresh_tokens'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
