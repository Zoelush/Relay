-- Email in the inbox (phase 12, step E4; docs/OMNICHANNEL_STEP4.md), behind `channels_v1` and
-- `channel_email_v1`. Additive: two checks are widened (a new delivery state and purpose), nothing
-- removed.

-- Zoe on email: off (the default), drafting replies a teammate approves, or answering. And where
-- her monitors' incident alerts are emailed.
ALTER TABLE ai_agents ADD COLUMN email_mode text NOT NULL DEFAULT 'off' CHECK(email_mode IN ('off','approve','answer'));
ALTER TABLE ai_agents ADD COLUMN incident_emails text[] NOT NULL DEFAULT '{}' CHECK(cardinality(incident_emails)<=5);

-- A delivery can wait for a teammate's approval (Zoe's draft on email), and can be a side
-- conversation's message to a third party.
ALTER TABLE channel_deliveries DROP CONSTRAINT channel_deliveries_status_check;
ALTER TABLE channel_deliveries ADD CONSTRAINT channel_deliveries_status_check CHECK(status IN ('queued','held','sent','delivered','read','failed','suppressed'));
ALTER TABLE channel_deliveries DROP CONSTRAINT channel_deliveries_purpose_check;
ALTER TABLE channel_deliveries ADD CONSTRAINT channel_deliveries_purpose_check CHECK(purpose IN ('reply','away','side'));
-- Who approved or discarded a held delivery, and when.
ALTER TABLE channel_deliveries ADD COLUMN decided_by text;
ALTER TABLE channel_deliveries ADD COLUMN decided_at timestamptz;

-- Side conversations: an email thread with someone other than the customer (a supplier, another
-- department), attached to a conversation. Its messages are internal parts of that conversation,
-- never the customer's; its own reply address (`<workspace>+s-<token>@<inbound domain>`) brings
-- answers back to it.
CREATE TABLE side_conversations (
 workspace_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL, subject text NOT NULL,
 participants text[] NOT NULL CHECK(cardinality(participants) BETWEEN 1 AND 10), token text NOT NULL,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,token),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE INDEX side_conversations_conversation ON side_conversations(workspace_id,conversation_id,created_at);
-- Each message in it (out and in), for threading and the list.
CREATE TABLE side_messages (
 workspace_id text NOT NULL, side_id text NOT NULL, part_id text NOT NULL, message_id text,
 direction text NOT NULL CHECK(direction IN ('out','in')), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,part_id),
 FOREIGN KEY(workspace_id,side_id) REFERENCES side_conversations(workspace_id,id));
CREATE INDEX side_messages_message_id ON side_messages(workspace_id,message_id) WHERE message_id IS NOT NULL;

-- Zoe's incident alerts by email: one per incident and address, through the suppression list.
CREATE TABLE email_alerts (
 workspace_id text NOT NULL, id text NOT NULL, incident_id text NOT NULL, address text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed','suppressed')),
 provider_id text, error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,incident_id,address));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['side_conversations','side_messages','email_alerts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
