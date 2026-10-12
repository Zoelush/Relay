-- Data connectors for Zoe (phase 09, step D1; docs/ACTIONS_STEP1.md), behind `ai_actions_v1`.
-- Additive. Read connectors only in this step; write access arrives with D3.

-- A workspace-defined HTTP integration. `draft` is what's being edited (validated in code,
-- server/connectors.ts); publishing copies it into an immutable version, and `live_version` is
-- the one new conversations use. Archived connectors stay for their audit rows.
CREATE TABLE ai_connectors (
 workspace_id text NOT NULL, id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
 access text NOT NULL DEFAULT 'read' CHECK(access IN ('read')),
 draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object'),
 live_version integer,
 archived boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX ai_connectors_name ON ai_connectors(workspace_id,lower(name)) WHERE NOT archived;

CREATE TABLE ai_connector_versions (
 workspace_id text NOT NULL, connector_id text NOT NULL, version integer NOT NULL CHECK(version>=1),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 published_by text NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connector_id,version),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES ai_connectors(workspace_id,id));
CREATE FUNCTION keep_ai_connector_versions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Published connector versions are never changed'; END $$;
CREATE TRIGGER immutable_ai_connector_versions BEFORE UPDATE OR DELETE ON ai_connector_versions FOR EACH ROW EXECUTE FUNCTION keep_ai_connector_versions();

-- The version a conversation started with, kept for the rest of it.
CREATE TABLE ai_connector_pins (
 workspace_id text NOT NULL, conversation_id text NOT NULL, connector_id text NOT NULL, version integer NOT NULL,
 pinned_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,conversation_id,connector_id),
 FOREIGN KEY(workspace_id,connector_id,version) REFERENCES ai_connector_versions(workspace_id,connector_id,version),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));

-- Credentials (an API key, a bearer token, an OAuth client secret), encrypted with
-- RELAY_CONNECTOR_KEY (AES-GCM, bound to workspace, connector and name). Never returned or logged;
-- not versioned, so rotating one needs no new version.
CREATE TABLE ai_connector_secrets (
 workspace_id text NOT NULL, connector_id text NOT NULL,
 name text NOT NULL CHECK(name IN ('api_key','token','client_secret')),
 wrapped text NOT NULL, hint text NOT NULL DEFAULT '' CHECK(length(hint)<=8),
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connector_id,name),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES ai_connectors(workspace_id,id));

-- An OAuth 2 client-credentials access token, encrypted likewise, until it expires.
CREATE TABLE ai_connector_tokens (
 workspace_id text NOT NULL, connector_id text NOT NULL,
 wrapped text NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,connector_id),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES ai_connectors(workspace_id,id));

-- Calls per connector per minute, for its rate limit.
CREATE TABLE ai_connector_rate (
 workspace_id text NOT NULL, connector_id text NOT NULL, minute timestamptz NOT NULL, calls integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,connector_id,minute));

-- The audit: every invocation, who and where, which version, the inputs (sensitive ones redacted),
-- the named values it returned (never the raw response), how long, and the result.
CREATE TABLE ai_connector_calls (
 workspace_id text NOT NULL, id text NOT NULL, connector_id text NOT NULL,
 version integer, draft boolean NOT NULL DEFAULT false,
 source text NOT NULL CHECK(source IN ('test','agent')),
 invoked_by text NOT NULL, conversation_id text,
 method text NOT NULL, url text NOT NULL,
 inputs jsonb NOT NULL DEFAULT '{}', outputs jsonb NOT NULL DEFAULT '{}',
 status integer, attempts integer NOT NULL DEFAULT 1, duration_ms integer NOT NULL,
 result text NOT NULL CHECK(result IN ('ok','http_error','timeout','refused','invalid_input','invalid_response','rate_limited','auth_failed','unreachable')),
 error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 CHECK(draft OR version IS NOT NULL),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES ai_connectors(workspace_id,id));
CREATE INDEX ai_connector_calls_connector ON ai_connector_calls(workspace_id,connector_id,created_at DESC);
CREATE INDEX ai_connector_calls_conversation ON ai_connector_calls(workspace_id,conversation_id,created_at) WHERE conversation_id IS NOT NULL;
CREATE FUNCTION keep_ai_connector_calls() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'The connector audit is append-only'; END $$;
CREATE TRIGGER immutable_ai_connector_calls BEFORE UPDATE OR DELETE ON ai_connector_calls FOR EACH ROW EXECUTE FUNCTION keep_ai_connector_calls();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ai_connectors','ai_connector_versions','ai_connector_pins','ai_connector_secrets','ai_connector_tokens','ai_connector_rate','ai_connector_calls'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'ai_actions_v1',false FROM workspace ON CONFLICT DO NOTHING;
