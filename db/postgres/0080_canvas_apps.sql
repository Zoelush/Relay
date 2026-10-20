-- Canvas apps (phase 15, step D5; docs/DEVELOPER_PLATFORM_STEP5.md), behind `developer_api_v1`.
-- Additive. An OAuth app may also draw cards in Relay: its canvas address, the placements it draws
-- in, and the secret Relay signs its requests with (sealed with the connector key; while one is
-- being replaced, the previous one also signs for 24 hours).
ALTER TABLE oauth_apps ADD COLUMN canvas_url text;
ALTER TABLE oauth_apps ADD COLUMN canvas_placements text[] NOT NULL DEFAULT '{}'
 CHECK(canvas_placements <@ ARRAY['conversation.sidebar','composer','settings']::text[]);
ALTER TABLE oauth_apps ADD COLUMN canvas_secret_sealed text;
ALTER TABLE oauth_apps ADD COLUMN canvas_secret_last_four text;
ALTER TABLE oauth_apps ADD COLUMN canvas_previous_secret_sealed text;
ALTER TABLE oauth_apps ADD COLUMN canvas_previous_until timestamptz;
-- What the app's configure step returned for this installation (passed to every request).
ALTER TABLE oauth_grants ADD COLUMN canvas_settings jsonb;
ALTER TABLE oauth_grants ADD COLUMN configured_at timestamptz;
-- A card on screen: the canvas the app last returned and its stored data, kept on the server so a
-- submit is checked against what was shown and stored data never reaches the browser. An hour.
CREATE TABLE canvas_sessions (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 grant_id text NOT NULL, placement text NOT NULL, conversation_id text, teammate_id text NOT NULL,
 canvas jsonb NOT NULL, stored_data jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,id));
CREATE INDEX canvas_sessions_grant ON canvas_sessions(workspace_id,grant_id,expires_at);
-- Every request to an app from this workspace, and how it went (30 days): the workspace's error rate.
CREATE TABLE canvas_calls (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 grant_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('initialize','submit','configure')),
 placement text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('ok','timeout','unreachable','http_error','invalid_response')),
 status_code int, duration_ms int NOT NULL, error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id));
CREATE INDEX canvas_calls_grant ON canvas_calls(workspace_id,grant_id,created_at);
-- Counts per day in the app's own workspace, across every installation: the developer's error rate.
-- Only counts cross over: nothing about the installing workspace's conversations or people.
CREATE TABLE canvas_app_daily (
 workspace_id text NOT NULL REFERENCES workspace(id), app_id text NOT NULL, day date NOT NULL,
 calls int NOT NULL DEFAULT 0, failures int NOT NULL DEFAULT 0, timeouts int NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,app_id,day));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['canvas_sessions','canvas_calls','canvas_app_daily'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
