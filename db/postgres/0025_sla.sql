-- SLAs (phase 05, step B2). A policy (the first enabled one, in order, whose conditions match)
-- sets targets for first response, next response, time to close and (tickets) time to resolve.
-- Clocks are derived from each conversation's own timeline; each clock row keeps the calendar
-- version it started under, and a breach, once recorded, is never cleared. Additive.
CREATE TABLE sla_policies (
 workspace_id text NOT NULL, id text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 position integer NOT NULL, conditions jsonb, targets jsonb NOT NULL,
 hours text NOT NULL DEFAULT 'business' CHECK(hours IN ('business','always')),
 pause jsonb NOT NULL DEFAULT '{}', enabled boolean NOT NULL DEFAULT true, archived boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id));
CREATE TABLE sla_clocks (
 workspace_id text NOT NULL, conversation_id text NOT NULL,
 metric text NOT NULL CHECK(metric IN ('first_response','next_response','time_to_close','time_to_resolve')),
 cycle integer NOT NULL DEFAULT 0, policy_id text, policy_version bigint, target_ms bigint,
 calendar_id text, calendar_version integer,
 events jsonb NOT NULL DEFAULT '[]', state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','paused','stopped','inactive')),
 elapsed_ms bigint NOT NULL DEFAULT 0, due_at timestamptz, breached_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,conversation_id,metric,cycle),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,calendar_id,calendar_version) REFERENCES business_calendars(workspace_id,id,version));
-- What views filter and sort on, and what timers wake for.
ALTER TABLE conversations ADD COLUMN sla_policy_id text;
ALTER TABLE conversations ADD COLUMN sla_next_due_at timestamptz;
ALTER TABLE conversations ADD COLUMN sla_sort_at timestamptz;
ALTER TABLE conversations ADD COLUMN sla_overdue boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN sla_breached boolean NOT NULL DEFAULT false;
CREATE INDEX conversations_sla_due ON conversations(workspace_id,sla_next_due_at) WHERE sla_next_due_at IS NOT NULL;
ALTER TABLE inbox_filter_members ADD COLUMN sla_sort_at timestamptz;
CREATE INDEX inbox_filter_sla ON inbox_filter_members(workspace_id,set_id,sla_sort_at,conversation_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sla_policies','sla_clocks'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
