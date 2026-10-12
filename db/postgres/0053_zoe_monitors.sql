-- Monitors and incidents for Zoe (phase 08, step C2b; docs/AI_STEP12.md), behind `zoe_monitors_v1`.
-- Additive (notifications' columns become nullable for a kind with no conversation).

-- Each built-in monitor's setting: on or off, and how sharp a change must be to open an incident.
-- A row exists once someone changes the default (on, medium).
CREATE TABLE ai_monitor_settings (
 workspace_id text NOT NULL, agent_id text NOT NULL,
 metric text NOT NULL CHECK(metric IN ('unknown_rate','handover_rate','blocked_rate','error_rate','helped_rate','bad_review_rate')),
 enabled boolean NOT NULL DEFAULT true,
 sensitivity text NOT NULL DEFAULT 'medium' CHECK(sensitivity IN ('low','medium','high')),
 version bigint NOT NULL DEFAULT 1, updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,agent_id,metric),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES ai_agents(workspace_id,id));

-- One row per checked UTC hour, written before the check, so it runs once an hour however often
-- the sweep does; and each monitor's numbers at that check (the last 24 hours against the 7 days
-- before). Kept 30 days.
CREATE TABLE ai_monitor_runs (
 workspace_id text NOT NULL, hour timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,hour));
CREATE TABLE ai_monitor_checks (
 workspace_id text NOT NULL, hour timestamptz NOT NULL, metric text NOT NULL,
 current real, baseline real, volume integer NOT NULL, baseline_volume integer NOT NULL,
 status text NOT NULL CHECK(status IN ('normal','tripped','low_volume','off')),
 PRIMARY KEY(workspace_id,hour,metric),
 FOREIGN KEY(workspace_id,hour) REFERENCES ai_monitor_runs(workspace_id,hour));

-- A sharp change: opened by a tripped monitor (one open per monitor), with the numbers, example
-- conversations and what changed nearby. Acknowledged or resolved by a teammate with a note;
-- resolved by itself after two normal checks in a row, or when its monitor is switched off.
CREATE TABLE ai_incidents (
 workspace_id text NOT NULL, id text NOT NULL, agent_id text NOT NULL, metric text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
 opened_at timestamptz NOT NULL DEFAULT now(),
 baseline real NOT NULL, opened_value real NOT NULL, latest_value real NOT NULL, worst_value real NOT NULL,
 volume integer NOT NULL,
 examples text[] NOT NULL DEFAULT '{}',
 changes jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(changes)='array'),
 normal_checks integer NOT NULL DEFAULT 0,
 last_checked_at timestamptz NOT NULL DEFAULT now(),
 acknowledged_by text, acknowledged_at timestamptz,
 resolution text CHECK(resolution IN ('auto','manual','monitor_off')),
 resolved_by text, resolved_at timestamptz,
 note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,id),
 CHECK((status='resolved')=(resolution IS NOT NULL) AND (status='resolved')=(resolved_at IS NOT NULL)),
 CHECK(status<>'acknowledged' OR acknowledged_at IS NOT NULL),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES ai_agents(workspace_id,id));
CREATE UNIQUE INDEX ai_incidents_one_open ON ai_incidents(workspace_id,metric) WHERE status<>'resolved';
CREATE INDEX ai_incidents_recent ON ai_incidents(workspace_id,opened_at DESC);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ai_monitor_settings','ai_monitor_runs','ai_monitor_checks','ai_incidents'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

-- An incident notifies those who manage Zoe in the app. A mention keeps its conversation, part and
-- author; an incident notification has none of those, only its incident.
ALTER TABLE notifications ALTER COLUMN conversation_id DROP NOT NULL,
 ALTER COLUMN part_id DROP NOT NULL,
 ALTER COLUMN actor_teammate_id DROP NOT NULL,
 ADD COLUMN incident_id text;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('mention','zoe_incident'));
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_fields CHECK(
 CASE kind WHEN 'mention' THEN conversation_id IS NOT NULL AND part_id IS NOT NULL AND actor_teammate_id IS NOT NULL AND incident_id IS NULL
 ELSE incident_id IS NOT NULL AND conversation_id IS NULL AND part_id IS NULL END);
CREATE UNIQUE INDEX notifications_incident ON notifications(workspace_id,teammate_id,incident_id) WHERE incident_id IS NOT NULL;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'zoe_monitors_v1',false FROM workspace ON CONFLICT DO NOTHING;
