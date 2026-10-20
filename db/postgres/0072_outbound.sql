-- Outbound: the engine and in-app chat messages (phase 13, step O2; docs/OUTBOUND_STEP2.md), behind
-- `outbound_v1` (and `segments_v1`). Additive.

-- The workspace's limits across all outbound: at most cap_count messages per contact in cap_days,
-- and quiet hours in the contact's timezone (the workspace's when theirs isn't known).
CREATE TABLE outbound_settings (
 workspace_id text NOT NULL, cap_count integer NOT NULL DEFAULT 3 CHECK(cap_count BETWEEN 1 AND 50),
 cap_days integer NOT NULL DEFAULT 7 CHECK(cap_days BETWEEN 1 AND 30),
 quiet_start text NOT NULL DEFAULT '21:00' CHECK(quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 quiet_end text NOT NULL DEFAULT '08:00' CHECK(quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 timezone text NOT NULL DEFAULT 'UTC', updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id));

-- A message: its draft, and the version live now (versions are immutable; contacts stay on theirs).
CREATE TABLE outbound_messages (
 workspace_id text NOT NULL, id text NOT NULL, type text NOT NULL CHECK(type IN ('chat')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','live','paused','archived')),
 draft jsonb NOT NULL, live_version integer, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id));
CREATE TABLE outbound_versions (
 workspace_id text NOT NULL, message_id text NOT NULL, version integer NOT NULL, definition jsonb NOT NULL,
 -- An edit can be scheduled: the version takes over at effective_at.
 effective_at timestamptz NOT NULL DEFAULT now(), published_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,message_id,version), FOREIGN KEY(workspace_id,message_id) REFERENCES outbound_messages(workspace_id,id));
CREATE TRIGGER immutable_outbound_versions BEFORE UPDATE OR DELETE ON outbound_versions FOR EACH ROW EXECUTE FUNCTION reject_part_mutation();

-- The per-contact ledger: each entry into a message (by its re-entry key), its group (sent, or the
-- held-out control), what happened (pending, sent, held out, suppressed), and what they did.
CREATE TABLE outbound_entries (
 workspace_id text NOT NULL, id text NOT NULL, message_id text NOT NULL, version integer NOT NULL, contact_id text NOT NULL,
 entry_key text NOT NULL, variant text NOT NULL DEFAULT 'message' CHECK(variant IN ('message','control')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','held_out','suppressed')),
 reason text NOT NULL DEFAULT '', due_at timestamptz NOT NULL DEFAULT now(), occurrence text NOT NULL DEFAULT '',
 channel text, conversation_id text, part_id text,
 created_at timestamptz NOT NULL DEFAULT now(), entered_at timestamptz, seen_at timestamptz, clicked_at timestamptz, dismissed_at timestamptz, replied_at timestamptz,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,message_id,entry_key),
 FOREIGN KEY(workspace_id,message_id) REFERENCES outbound_messages(workspace_id,id),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id));
CREATE INDEX outbound_entries_contact ON outbound_entries(workspace_id,contact_id,status,entered_at);
CREATE INDEX outbound_entries_message ON outbound_entries(workspace_id,message_id,status);
CREATE INDEX outbound_entries_conversation ON outbound_entries(workspace_id,conversation_id) WHERE conversation_id IS NOT NULL;

-- One row per contact, taken FOR UPDATE while choosing whether to send: caps hold under a burst.
CREATE TABLE outbound_contact_locks (workspace_id text NOT NULL, contact_id text NOT NULL, PRIMARY KEY(workspace_id,contact_id));

-- Each audience snapshot taken (a one-off's launch, each recurring occurrence), once.
CREATE TABLE outbound_occurrences (
 workspace_id text NOT NULL, message_id text NOT NULL, occurrence text NOT NULL, version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,message_id,occurrence));

-- A conversation an outbound chat started (kept out of the closed-reply rule until they reply).
ALTER TABLE conversations ADD COLUMN outbound_message_id text;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['outbound_settings','outbound_messages','outbound_versions','outbound_entries','outbound_contact_locks','outbound_occurrences'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'outbound_v1',false FROM workspace ON CONFLICT DO NOTHING;
