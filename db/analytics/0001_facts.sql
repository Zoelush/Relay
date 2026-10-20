-- The analytical store (phase 14, step R1; docs/REPORTING_STEP1.md): a separate database that only
-- the projection (`analytics.project`) writes and only reports read. Every table is per workspace,
-- with row-level security, as in the application database.

-- How far the projection has read each workspace: conversations changed after the watermark (less
-- an overlap, as commits can land out of order), and when it last ran.
CREATE TABLE a_projection (
 workspace_id text NOT NULL, watermark timestamptz NOT NULL DEFAULT '-infinity', changes_watermark timestamptz NOT NULL DEFAULT '-infinity',
 projected_at timestamptz, PRIMARY KEY(workspace_id));

-- The event stream: each conversation's parts, append-only, in their order (seq).
CREATE TABLE a_parts (
 workspace_id text NOT NULL, conversation_id text NOT NULL, seq bigint NOT NULL, id text NOT NULL,
 kind text NOT NULL, author_type text NOT NULL, author_id text NOT NULL, audience text NOT NULL, channel text,
 at timestamptz NOT NULL, data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(workspace_id,conversation_id,seq));
CREATE INDEX a_parts_time ON a_parts(workspace_id,at);

-- Who the customer was when it started (from the application's snapshot), and every later change.
CREATE TABLE a_snapshots (
 workspace_id text NOT NULL, conversation_id text NOT NULL, contact_id text, role text, profile jsonb NOT NULL DEFAULT '{}',
 taken_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,conversation_id));
CREATE TABLE a_contact_changes (
 workspace_id text NOT NULL, id text NOT NULL, contact_id text NOT NULL, role text NOT NULL, profile jsonb NOT NULL,
 changed_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,id));
CREATE INDEX a_contact_changes_contact ON a_contact_changes(workspace_id,contact_id,changed_at);

-- Calendar versions conversations are pinned to (immutable, copied once): office hours for durations.
CREATE TABLE a_calendars (
 workspace_id text NOT NULL, id text NOT NULL, version integer NOT NULL, timezone text NOT NULL, schedule jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id,version));

-- Each conversation's facts, worked out from its parts (lib/metrics.ts `conversationFacts`) and
-- recomputed whenever new parts arrive. Durations in milliseconds, wall-clock and office hours.
CREATE TABLE a_conversations (
 workspace_id text NOT NULL, conversation_id text NOT NULL, brand_id text, channel text NOT NULL,
 started_at timestamptz NOT NULL, calendar_id text, calendar_version integer, projected_seq bigint NOT NULL DEFAULT 0,
 first_customer_at timestamptz, first_response_at timestamptz, first_response_ms bigint, first_response_business_ms bigint,
 first_closed_at timestamptz, time_to_close_ms bigint, time_to_close_business_ms bigint,
 customer_messages integer NOT NULL DEFAULT 0, teammate_replies integer NOT NULL DEFAULT 0, ai_replies integer NOT NULL DEFAULT 0,
 workflow_messages integer NOT NULL DEFAULT 0, closes integer NOT NULL DEFAULT 0, reopens integer NOT NULL DEFAULT 0,
 assignments integer NOT NULL DEFAULT 0, ai_involved boolean NOT NULL DEFAULT false, ai_handed_over boolean NOT NULL DEFAULT false,
 rating integer, status text NOT NULL,
 -- Back-office tickets are internal; an outbound chat (phase 13) is the company's until they reply.
 visibility text NOT NULL DEFAULT 'customer', outbound boolean NOT NULL DEFAULT false,
 -- Merged into another conversation: counted as the one it joined.
 merged boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,conversation_id));
CREATE INDEX a_conversations_started ON a_conversations(workspace_id,started_at);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['a_projection','a_parts','a_snapshots','a_contact_changes','a_calendars','a_conversations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
