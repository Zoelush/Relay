-- The analytical store's datasets (phase 14, step R2; docs/REPORTING_STEP2.md): what every metric in
-- lib/metrics.ts reads. Per conversation, worked out by the projection from its parts: state
-- periods, each customer message's response, and each teammate's handling periods. Copied from the
-- application: SLA targets, tickets, Zoe's answers and resolutions, outbound's ledger, calls, help
-- center searches and article feedback, teammates and their presence.

ALTER TABLE a_conversations ADD COLUMN team_id text;
ALTER TABLE a_conversations ADD COLUMN assignee text;
ALTER TABLE a_conversations ADD COLUMN last_closed_at timestamptz;
-- First-contact resolution: teammate replies before the first close, and a reopen within 7 days of it.
ALTER TABLE a_conversations ADD COLUMN replies_before_first_close integer NOT NULL DEFAULT 0;
ALTER TABLE a_conversations ADD COLUMN reopened_within_7d boolean NOT NULL DEFAULT false;
-- Zoe's first reply: the AI agent's rates are anchored to it.
ALTER TABLE a_conversations ADD COLUMN first_ai_at timestamptz;
CREATE INDEX a_conversations_first_ai ON a_conversations(workspace_id,first_ai_at) WHERE first_ai_at IS NOT NULL;
-- When the latest rating was given (rating is its value): CSAT is anchored to it.
ALTER TABLE a_conversations ADD COLUMN rated_at timestamptz;
CREATE INDEX a_conversations_rated ON a_conversations(workspace_id,rated_at) WHERE rated_at IS NOT NULL;
-- When a conversation counts as started (an outbound chat at the customer's first message): the
-- expression is server/reports.ts's startOf, exactly, so the planner can use it.
CREATE INDEX a_conversations_start ON a_conversations(workspace_id,(CASE WHEN outbound THEN first_customer_at ELSE started_at END));
-- A contact's other conversations (repeat contact).
CREATE INDEX a_snapshots_contact ON a_snapshots(workspace_id,contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX a_conversations_first_response ON a_conversations(workspace_id,first_response_at) WHERE first_response_at IS NOT NULL;
CREATE INDEX a_conversations_first_closed ON a_conversations(workspace_id,first_closed_at) WHERE first_closed_at IS NOT NULL;
CREATE INDEX a_parts_kind ON a_parts(workspace_id,kind,at);

-- Each period a conversation spent in a state (open, snoozed, closed); the last has no end.
CREATE TABLE a_states (
 workspace_id text NOT NULL, conversation_id text NOT NULL, seq bigint NOT NULL, state text NOT NULL,
 from_at timestamptz NOT NULL, to_at timestamptz, PRIMARY KEY(workspace_id,conversation_id,seq));
CREATE INDEX a_states_time ON a_states(workspace_id,state,from_at);

-- Each customer message answered by a teammate: when, by whom, how long (wall-clock and office hours).
CREATE TABLE a_responses (
 workspace_id text NOT NULL, conversation_id text NOT NULL, customer_seq bigint NOT NULL, first boolean NOT NULL,
 customer_at timestamptz NOT NULL, response_at timestamptz NOT NULL, teammate_id text NOT NULL,
 ms bigint NOT NULL, business_ms bigint NOT NULL, PRIMARY KEY(workspace_id,conversation_id,customer_seq));
CREATE INDEX a_responses_time ON a_responses(workspace_id,response_at);

-- Each period a conversation was open and assigned to a teammate, and how much of it they were active
-- in (no gap over 30 minutes without their reply or note), in office hours too.
CREATE TABLE a_handling (
 workspace_id text NOT NULL, conversation_id text NOT NULL, seq bigint NOT NULL, teammate_id text NOT NULL,
 from_at timestamptz NOT NULL, to_at timestamptz NOT NULL, ms bigint NOT NULL, active_ms bigint NOT NULL, active_business_ms bigint NOT NULL,
 PRIMARY KEY(workspace_id,conversation_id,seq));
CREATE INDEX a_handling_time ON a_handling(workspace_id,to_at);

-- Copied from the application, each kept current by its own watermark.
CREATE TABLE a_sources (workspace_id text NOT NULL, source text NOT NULL, watermark timestamptz NOT NULL DEFAULT '-infinity', PRIMARY KEY(workspace_id,source));
CREATE TABLE a_sla (
 workspace_id text NOT NULL, conversation_id text NOT NULL, metric text NOT NULL, cycle integer NOT NULL, policy_id text,
 target_ms bigint, state text NOT NULL, due_at timestamptz, breached_at timestamptz, updated_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,conversation_id,metric,cycle));
CREATE TABLE a_tickets (
 workspace_id text NOT NULL, conversation_id text NOT NULL, number bigint NOT NULL, type_id text NOT NULL, category text NOT NULL,
 state_kind text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,conversation_id));
CREATE TABLE a_ai_answers (
 workspace_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL, outcome text NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,id));
CREATE TABLE a_ai_resolutions (
 workspace_id text NOT NULL, id text NOT NULL, kind text NOT NULL, resolution_id text, conversation_id text NOT NULL, rule text NOT NULL,
 recorded_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,id));
CREATE INDEX a_ai_resolutions_conversation ON a_ai_resolutions(workspace_id,conversation_id);
CREATE TABLE a_outbound (
 workspace_id text NOT NULL, id text NOT NULL, message_id text NOT NULL, type text NOT NULL, variant text NOT NULL, status text NOT NULL,
 entered_at timestamptz, seen_at timestamptz, clicked_at timestamptz, dismissed_at timestamptz, replied_at timestamptz,
 PRIMARY KEY(workspace_id,id));
CREATE TABLE a_calls (
 workspace_id text NOT NULL, id text NOT NULL, conversation_id text, status text NOT NULL, voicemail boolean NOT NULL, answered boolean NOT NULL,
 zoe_turns integer NOT NULL, duration_seconds integer, started_at timestamptz NOT NULL, ended_at timestamptz, PRIMARY KEY(workspace_id,id));
CREATE TABLE a_searches (
 workspace_id text NOT NULL, id text NOT NULL, surface text NOT NULL, results integer NOT NULL, opened boolean NOT NULL,
 created_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,id));
CREATE TABLE a_feedback (
 workspace_id text NOT NULL, id text NOT NULL, record_id text NOT NULL, helpful boolean NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,id));
-- Each delivery on a non-messenger channel (email deliverability, Zoe's drafts a teammate decided).
CREATE TABLE a_deliveries (
 workspace_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL, channel text NOT NULL, status text NOT NULL, kind text NOT NULL,
 decided boolean NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,id));
CREATE TABLE a_teammates (
 workspace_id text NOT NULL, id text NOT NULL, name text NOT NULL, presence text NOT NULL, teams text[] NOT NULL DEFAULT '{}',
 PRIMARY KEY(workspace_id,id));
CREATE TABLE a_presence_changes (
 workspace_id text NOT NULL, id text NOT NULL, teammate_id text NOT NULL, from_presence text NOT NULL, to_presence text NOT NULL,
 changed_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,id));
CREATE INDEX a_presence_changes_teammate ON a_presence_changes(workspace_id,teammate_id,changed_at);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['a_states','a_responses','a_handling','a_sources','a_sla','a_tickets','a_ai_answers','a_ai_resolutions','a_outbound','a_calls','a_searches','a_feedback','a_deliveries','a_teammates','a_presence_changes'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

-- Conversations already projected get the new columns and derived rows on the next run: it
-- recomputes each from its stored parts (idempotent), so the store needs no rebuild by hand.
UPDATE a_projection SET watermark='-infinity'
