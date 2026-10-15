-- Events, subscription types and segments (phase 13, step O1; docs/OUTBOUND_STEP1.md): the phase 01
-- pieces outbound stands on, behind `segments_v1`. Additive.

-- What a contact did ("upgraded plan"), from the messenger (signed-in users) or the customer's
-- server (signed with the workspace's identity key). Kept once per sender's id.
CREATE TABLE contact_events (
 workspace_id text NOT NULL, id text NOT NULL, contact_id text NOT NULL, name text NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
 source text NOT NULL CHECK(source IN ('messenger','api')), dedupe_key text NOT NULL,
 occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,dedupe_key),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id));
CREATE INDEX contact_events_contact ON contact_events(workspace_id,contact_id,name,occurred_at DESC);
CREATE INDEX contact_events_name ON contact_events(workspace_id,name,occurred_at DESC);

-- Each event name seen: described by managers, archived to stop tracking it (120 tracked at most).
CREATE TABLE event_definitions (
 workspace_id text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '' CHECK(length(description)<=300),
 count bigint NOT NULL DEFAULT 0, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 archived_at timestamptz, PRIMARY KEY(workspace_id,name));

-- Kinds of message a contact can choose to get: opt-in (sent only once they agree) or opt-out
-- (sent until they say no), for one channel. Archived, never deleted.
CREATE TABLE subscription_types (
 workspace_id text NOT NULL, id text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=300),
 consent text NOT NULL CHECK(consent IN ('opt_in','opt_out')),
 channel text NOT NULL CHECK(channel IN ('email','sms','whatsapp','in_app')),
 archived_at timestamptz, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX subscription_types_name ON subscription_types(workspace_id,lower(name)) WHERE archived_at IS NULL;

-- A contact's choice for a type (no row: the type's consent decides), and every change to it.
CREATE TABLE contact_subscriptions (
 workspace_id text NOT NULL, contact_id text NOT NULL, subscription_type_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('opted_in','opted_out')), changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,contact_id,subscription_type_id),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id),
 FOREIGN KEY(workspace_id,subscription_type_id) REFERENCES subscription_types(workspace_id,id));
CREATE TABLE contact_subscription_changes (
 workspace_id text NOT NULL, id text NOT NULL, contact_id text NOT NULL,
 -- NULL: everything (unsubscribed from all, or back).
 subscription_type_id text, state text NOT NULL CHECK(state IN ('opted_in','opted_out')),
 source text NOT NULL CHECK(source IN ('preference_page','teammate','import','merge')), actor text,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id));
CREATE INDEX contact_subscription_changes_contact ON contact_subscription_changes(workspace_id,contact_id,created_at);
CREATE TRIGGER immutable_subscription_changes BEFORE UPDATE OR DELETE ON contact_subscription_changes FOR EACH ROW EXECUTE FUNCTION reject_part_mutation();

-- Saved segments: rules over contacts (lib/segments.ts), archived, never deleted. The predefined
-- ones (all users, all leads, active, new) are code, not rows.
CREATE TABLE segments (
 workspace_id text NOT NULL, id text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 archived_at timestamptz, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX segments_name ON segments(workspace_id,lower(name)) WHERE archived_at IS NULL;

-- A delivery may be a message of a subscription type (outbound, from O2): the gate checks it.
ALTER TABLE channel_deliveries ADD COLUMN subscription_type_id text;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['contact_events','event_definitions','subscription_types','contact_subscriptions','contact_subscription_changes','segments'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'segments_v1',false FROM workspace ON CONFLICT DO NOTHING;
