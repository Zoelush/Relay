-- Instagram and Facebook Messenger (phase 12, step E7; docs/OMNICHANNEL_STEP7.md), behind
-- `channels_v1` and `channel_facebook_v1` / `channel_instagram_v1`. Additive.

-- A brand's Facebook Page (its Messenger) and the Instagram business account linked to it,
-- connected with the workspace's own Meta app: the page's access token and the app's secret
-- (sealed with RELAY_CONNECTOR_KEY, never shown again), and the webhook's verify token.
CREATE TABLE meta_pages (
 workspace_id text NOT NULL, id text NOT NULL, brand_id text NOT NULL,
 page_id text NOT NULL, page_name text NOT NULL DEFAULT '', ig_account_id text, ig_username text NOT NULL DEFAULT '',
 token_sealed text NOT NULL, token_hint text NOT NULL DEFAULT '', app_secret_sealed text NOT NULL, verify_token text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','failed','disconnected')), error text NOT NULL DEFAULT '',
 checked_at timestamptz, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,page_id),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));

-- Each webhook call (its signature checked before it was kept), until the `meta.receive` job reads it.
CREATE TABLE meta_inbound (
 workspace_id text NOT NULL, id text NOT NULL, object text NOT NULL, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','read','failed')), error text NOT NULL DEFAULT '',
 received_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 PRIMARY KEY(workspace_id,id));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['meta_pages','meta_inbound'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'channel_facebook_v1',false FROM workspace ON CONFLICT DO NOTHING;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'channel_instagram_v1',false FROM workspace ON CONFLICT DO NOTHING;
