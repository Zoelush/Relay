ALTER TABLE conversations ADD COLUMN brand_id text;
ALTER TABLE conversations ADD COLUMN primary_identity_id text;
ALTER TABLE conversations ADD COLUMN next_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN snooze_until timestamptz;
ALTER TABLE conversations ADD COLUMN snooze_version bigint NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN team_id text;
ALTER TABLE conversations ADD COLUMN channel text NOT NULL DEFAULT 'messenger';
ALTER TABLE conversations ADD COLUMN merged_into_id text;
ALTER TABLE conversations ADD COLUMN timeline_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN last_contact_reply_at timestamptz;
ALTER TABLE conversations ADD COLUMN last_teammate_reply_at timestamptz;
ALTER TABLE conversations ADD COLUMN first_response_ms bigint;
ALTER TABLE conversations ADD COLUMN title_source text NOT NULL DEFAULT 'generated';
ALTER TABLE conversations ADD COLUMN rating smallint CHECK(rating BETWEEN 1 AND 5);
ALTER TABLE conversations ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN topics text[] NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD CONSTRAINT conversation_brand FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id);
ALTER TABLE conversations ADD CONSTRAINT conversation_identity FOREIGN KEY(workspace_id,primary_identity_id) REFERENCES identities(workspace_id,id);
ALTER TABLE conversations ADD CONSTRAINT conversation_team FOREIGN KEY(workspace_id,team_id) REFERENCES teams(workspace_id,id);
ALTER TABLE conversations ADD CONSTRAINT conversation_redirect FOREIGN KEY(workspace_id,merged_into_id) REFERENCES conversations(workspace_id,id);
CREATE TABLE conversation_parts (
 workspace_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL, seq bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('customer_message','teammate_reply','internal_note','ai_reply','assignment_change','state_change','priority_change','tag_change','participant_change','attribute_change','rating','attachment','system_event','channel_handover','merge_marker')),
 author_type text NOT NULL CHECK(author_type IN ('contact','teammate','ai','system')), author_id text NOT NULL,
 audience text NOT NULL CHECK(audience IN ('public','internal')), channel text NOT NULL,
 body text NOT NULL DEFAULT '', data jsonb NOT NULL DEFAULT '{}', supersedes_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), origin_timezone text,
 delivery_status text NOT NULL DEFAULT 'accepted',
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,conversation_id,seq),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,supersedes_id) REFERENCES conversation_parts(workspace_id,id)
);
CREATE INDEX parts_timeline ON conversation_parts(workspace_id,conversation_id,seq);
CREATE FUNCTION reject_part_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Conversation parts are append-only'; END $$;
CREATE TRIGGER immutable_parts BEFORE UPDATE OR DELETE ON conversation_parts FOR EACH ROW EXECUTE FUNCTION reject_part_mutation();
CREATE TABLE conversation_part_delivery_events (
 workspace_id text NOT NULL, id text NOT NULL, part_id text NOT NULL, status text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,part_id) REFERENCES conversation_parts(workspace_id,id)
);
CREATE TABLE conversation_cycles (
 workspace_id text NOT NULL, conversation_id text NOT NULL, opened_seq bigint NOT NULL,
 opened_at timestamptz NOT NULL, closed_at timestamptz, closed_seq bigint,
 PRIMARY KEY(workspace_id,conversation_id,opened_seq), FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE UNIQUE INDEX one_open_cycle ON conversation_cycles(workspace_id,conversation_id) WHERE closed_at IS NULL;
CREATE TABLE conversation_participants (
 workspace_id text NOT NULL, conversation_id text NOT NULL, identity_id text NOT NULL,
 PRIMARY KEY(workspace_id,conversation_id,identity_id), FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,identity_id) REFERENCES identities(workspace_id,id)
);
CREATE TABLE conversation_reads (
 workspace_id text NOT NULL, conversation_id text NOT NULL, teammate_id text NOT NULL, read_seq bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,conversation_id,teammate_id), FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id)
);
CREATE TABLE conversation_search_documents (
 workspace_id text NOT NULL, conversation_id text NOT NULL, part_id text NOT NULL, audience text NOT NULL,
 document tsvector NOT NULL, revision bigint NOT NULL, PRIMARY KEY(workspace_id,part_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,part_id) REFERENCES conversation_parts(workspace_id,id)
);
CREATE INDEX conversation_search_gin ON conversation_search_documents USING gin(document);
CREATE TABLE inbox_counters (
 workspace_id text NOT NULL, teammate_id text NOT NULL, view text NOT NULL, count bigint NOT NULL DEFAULT 0 CHECK(count>=0),version bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,teammate_id,view), FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id)
);
CREATE TABLE conversation_unread (
 workspace_id text NOT NULL, teammate_id text NOT NULL, conversation_id text NOT NULL, views text[] NOT NULL,
 PRIMARY KEY(workspace_id,teammate_id,conversation_id), FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE TABLE attachments (
 workspace_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL, owner_identity_id text,
 object_key text NOT NULL, name text NOT NULL, size bigint NOT NULL CHECK(size BETWEEN 1 AND 26214400), mime text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','scanning','clean','rejected','failed')),
 checksum text, clean_key text, preview_key text, version bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_identity_id) REFERENCES identities(workspace_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['conversation_parts','conversation_part_delivery_events','conversation_cycles','conversation_participants','conversation_reads','conversation_search_documents','inbox_counters','conversation_unread','attachments'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
