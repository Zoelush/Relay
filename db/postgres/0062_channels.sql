-- The channel contract (phase 12, step E1; docs/OMNICHANNEL_STEP1.md), behind `channels_v1`.
-- Additive.

-- A customer reached on a channel by its own address (an email address, a phone number): an
-- identity of kind `channel`, keeping the address (to send to) and whether the channel vouched
-- for it. Its contact is shared across channels only when the address is verified.
ALTER TABLE identities DROP CONSTRAINT identities_kind_check;
ALTER TABLE identities ADD CONSTRAINT identities_kind_check CHECK(kind IN ('anonymous','user','channel'));
CREATE TABLE identity_addresses (
 workspace_id text NOT NULL, identity_id text NOT NULL, channel text NOT NULL, address text NOT NULL,
 verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,identity_id), UNIQUE(workspace_id,channel,address),
 FOREIGN KEY(workspace_id,identity_id) REFERENCES identities(workspace_id,id));

-- The channel the customer last wrote on: replies go there. `channel` stays the first one.
ALTER TABLE conversations ADD COLUMN current_channel text;
UPDATE conversations SET current_channel=channel WHERE current_channel IS NULL;
ALTER TABLE conversations ALTER COLUMN current_channel SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN current_channel SET DEFAULT 'messenger';

-- How inbound messages find their conversation (a channel's thread keys), and each provider
-- message once (a retried webhook adds nothing).
CREATE TABLE channel_threads (
 workspace_id text NOT NULL, channel text NOT NULL, thread_key text NOT NULL, conversation_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,channel,thread_key),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE TABLE channel_messages (
 workspace_id text NOT NULL, channel text NOT NULL, external_id text NOT NULL, part_id text NOT NULL,
 conversation_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,channel,external_id));

-- Every outbound part to a channel that isn't the messenger: one delivery, sent by a job, with
-- its status as the provider reports it.
CREATE TABLE channel_deliveries (
 workspace_id text NOT NULL, id text NOT NULL, part_id text NOT NULL, conversation_id text NOT NULL,
 channel text NOT NULL, identity_id text NOT NULL, address text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','delivered','read','failed','suppressed')),
 attempts integer NOT NULL DEFAULT 0, provider_id text, error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,part_id,identity_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE INDEX channel_deliveries_conversation ON channel_deliveries(workspace_id,conversation_id,created_at);
CREATE INDEX channel_deliveries_provider ON channel_deliveries(workspace_id,channel,provider_id) WHERE provider_id IS NOT NULL;

-- Addresses nothing is sent to: hard bounces, complaints, opt-outs and manual blocks. Kept when
-- lifted (who and when); opt-outs and complaints can't be lifted by a teammate.
CREATE TABLE suppressions (
 workspace_id text NOT NULL, id text NOT NULL, channel text NOT NULL, address text NOT NULL,
 reason text NOT NULL CHECK(reason IN ('manual','hard_bounce','complaint','opt_out')),
 source text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
 created_by text, created_at timestamptz NOT NULL DEFAULT now(),
 lifted_at timestamptz, lifted_by text,
 PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX suppressions_active ON suppressions(workspace_id,channel,address) WHERE lifted_at IS NULL;

-- Office hours per channel: a calendar assigned to a channel.
ALTER TABLE calendar_assignments DROP CONSTRAINT calendar_assignments_scope_check;
ALTER TABLE calendar_assignments ADD CONSTRAINT calendar_assignments_scope_check CHECK(scope IN ('workspace','brand','team','channel'));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['identity_addresses','channel_threads','channel_messages','channel_deliveries','suppressions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'channels_v1',false FROM workspace ON CONFLICT DO NOTHING;
