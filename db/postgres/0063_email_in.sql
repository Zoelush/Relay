-- Email in (phase 12, step E2; docs/OMNICHANNEL_STEP2.md), behind `channels_v1` and `channel_email_v1`.
-- Additive.

-- Each brand's inbound address is `<workspace>+<token>@<inbound domain>`: the token (unguessable,
-- replaceable) finds the brand, so nobody can mail into a workspace without it. The brand's own
-- support address forwards there; forwarding is confirmed when a forwarded message arrives, and a
-- Gmail forwarding confirmation is kept to show the manager instead of opening a conversation.
CREATE TABLE email_settings (
 workspace_id text NOT NULL, brand_id text NOT NULL, token text NOT NULL,
 support_address text, forwarding_verified_at timestamptz, confirmation jsonb,
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,brand_id), UNIQUE(workspace_id,token),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));

-- Every email that reached an inbound address: received (its raw bytes in storage until read),
-- then read into a conversation (or kept as an automatic message, a bounce or a confirmation), or
-- failed with why.
CREATE TABLE email_inbound (
 workspace_id text NOT NULL, id text NOT NULL, brand_id text NOT NULL,
 envelope_from text NOT NULL DEFAULT '', envelope_to text NOT NULL, raw_key text NOT NULL, size integer NOT NULL,
 status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','read','failed')),
 kind text CHECK(kind IN ('message','auto_reply','bounce','confirmation')),
 error text NOT NULL DEFAULT '', conversation_id text, part_id text,
 received_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 PRIMARY KEY(workspace_id,id));
CREATE INDEX email_inbound_recent ON email_inbound(workspace_id,received_at DESC);

-- The whole of each email that became a part: headers worth keeping, the full text, and its HTML
-- made safe once (remote images blocked), with its attachments and whether each was kept. The
-- part itself holds only the new text.
CREATE TABLE email_messages (
 workspace_id text NOT NULL, part_id text NOT NULL, conversation_id text NOT NULL, inbound_id text NOT NULL,
 message_id text, subject text NOT NULL DEFAULT '', from_address text NOT NULL, from_name text NOT NULL DEFAULT '',
 to_addresses text[] NOT NULL DEFAULT '{}', cc_addresses text[] NOT NULL DEFAULT '{}', sent_at timestamptz,
 text_full text NOT NULL DEFAULT '', html text, stripped boolean NOT NULL DEFAULT false, forwarded boolean NOT NULL DEFAULT false,
 verified boolean NOT NULL DEFAULT false, kind text NOT NULL, reason text NOT NULL DEFAULT '', remote_images integer NOT NULL DEFAULT 0,
 attachments jsonb NOT NULL DEFAULT '[]', headers jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,part_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE INDEX email_messages_message_id ON email_messages(workspace_id,message_id) WHERE message_id IS NOT NULL;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['email_settings','email_inbound','email_messages'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'channel_email_v1',false FROM workspace ON CONFLICT DO NOTHING;
