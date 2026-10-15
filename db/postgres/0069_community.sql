-- Slack and Discord (phase 12, step E8; docs/OMNICHANNEL_STEP8.md), behind `channels_v1` and
-- `channel_slack_v1` / `channel_discord_v1`. Additive.

-- A connected Slack workspace or Discord server (its bot), for a brand: the bot's token and, for
-- Slack, its signing secret (sealed with RELAY_CONNECTOR_KEY, never shown again). Discord's
-- gateway connection (held by a Durable Object) reports its state here.
CREATE TABLE community_connections (
 workspace_id text NOT NULL, id text NOT NULL, platform text NOT NULL CHECK(platform IN ('slack','discord')), brand_id text NOT NULL,
 external_id text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', bot_user_id text NOT NULL DEFAULT '',
 token_sealed text NOT NULL, token_hint text NOT NULL DEFAULT '', secret_sealed text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','failed','disconnected')), error text NOT NULL DEFAULT '',
 gateway_state text NOT NULL DEFAULT '', gateway_at timestamptz,
 checked_at timestamptz, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));
CREATE UNIQUE INDEX community_connections_external ON community_connections(workspace_id,platform,external_id) WHERE external_id<>'' AND status<>'disconnected';

-- Each event (a Slack call, its signature checked; a Discord gateway dispatch), until the
-- `community.receive` job reads it. Slack's event ids are kept once (it retries).
CREATE TABLE community_inbound (
 workspace_id text NOT NULL, id text NOT NULL, platform text NOT NULL, connection_id text NOT NULL, event_id text, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','read','failed')), error text NOT NULL DEFAULT '',
 received_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX community_inbound_event ON community_inbound(workspace_id,platform,event_id) WHERE event_id IS NOT NULL;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['community_connections','community_inbound'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'channel_slack_v1',false FROM workspace ON CONFLICT DO NOTHING;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'channel_discord_v1',false FROM workspace ON CONFLICT DO NOTHING;
