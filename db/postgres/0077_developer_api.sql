-- The developer platform's foundation (phase 15, step D1; docs/DEVELOPER_PLATFORM_STEP1.md), behind
-- `developer_api_v1`. Additive. Personal access tokens are kept only as hashes; a token acts as the
-- teammate who made it, within the scopes they chose (never more than their own capabilities).
CREATE TABLE api_tokens (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, teammate_id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 token_hash text NOT NULL UNIQUE, last_four text NOT NULL,
 scopes text[] NOT NULL, version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz,
 revoked_at timestamptz, revoked_by text,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id));
CREATE INDEX api_tokens_teammate ON api_tokens(workspace_id,teammate_id);
-- Calls per token per minute, and how many were refused for the rate limit: the Developers page's
-- usage (kept seven days: older minutes go as tokens are used).
CREATE TABLE api_usage (
 workspace_id text NOT NULL, token_id text NOT NULL, minute timestamptz NOT NULL,
 calls integer NOT NULL DEFAULT 0, limited integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,token_id,minute));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['api_tokens','api_usage'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'developer_api_v1',false FROM workspace ON CONFLICT DO NOTHING;
