-- OAuth on the workspace's behalf for data connectors (phase 09, step D4; docs/ACTIONS_STEP4.md),
-- behind `ai_actions_v1`. Additive.

-- A connector connected through OAuth 2 (authorization code) keeps its refresh token, encrypted
-- like any credential; who connected it is the secret's updated_by.
ALTER TABLE ai_connector_secrets DROP CONSTRAINT ai_connector_secrets_name_check;
ALTER TABLE ai_connector_secrets ADD CONSTRAINT ai_connector_secrets_name_check CHECK(name IN ('api_key','token','client_secret','refresh_token'));

-- A connection in progress: the state sent to the provider (stored hashed), the PKCE verifier
-- (encrypted), the redirect address, and who started it. Used once, within 10 minutes.
CREATE TABLE ai_connector_oauth_states (
 workspace_id text NOT NULL, state_hash text NOT NULL, connector_id text NOT NULL,
 teammate_id text NOT NULL, verifier text NOT NULL, redirect_uri text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,state_hash),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES ai_connectors(workspace_id,id));
ALTER TABLE ai_connector_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_connector_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ai_connector_oauth_states USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
