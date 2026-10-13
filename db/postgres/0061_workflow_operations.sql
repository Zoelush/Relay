-- Workflows in operation (phase 11, step W4; docs/WORKFLOWS_STEP4.md), behind `workflows_v1`:
-- the failing alert, triggers from time, outside systems and browsing, and reusable workflows.
-- Additive.

-- An alert while a workflow keeps failing: opened after three failed runs in a row, closed by the
-- next run that completes or by a manager. One open alert per workflow.
CREATE TABLE workflow_alerts (
 workspace_id text NOT NULL, id text NOT NULL, workflow_id text NOT NULL,
 opened_at timestamptz NOT NULL DEFAULT now(), failures integer NOT NULL,
 last_error text NOT NULL DEFAULT '', last_run_id text,
 resolved_at timestamptz, resolved_by text, resolution text CHECK(resolution IN ('recovered','dismissed','rolled_back')),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,workflow_id) REFERENCES workflows(workspace_id,id));
CREATE UNIQUE INDEX workflow_alerts_open ON workflow_alerts(workspace_id,workflow_id) WHERE resolved_at IS NULL;

-- Its notification to those who manage the workspace (like Zoe's incidents: no conversation).
ALTER TABLE notifications ADD COLUMN workflow_alert_id text;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('mention','zoe_incident','workflow_alert'));
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_fields;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_fields CHECK(
 CASE kind
  WHEN 'mention' THEN conversation_id IS NOT NULL AND part_id IS NOT NULL AND actor_teammate_id IS NOT NULL AND incident_id IS NULL AND workflow_alert_id IS NULL
  WHEN 'zoe_incident' THEN incident_id IS NOT NULL AND conversation_id IS NULL AND part_id IS NULL AND workflow_alert_id IS NULL
  ELSE workflow_alert_id IS NOT NULL AND incident_id IS NULL AND conversation_id IS NULL AND part_id IS NULL END);
CREATE UNIQUE INDEX notifications_workflow_alert ON notifications(workspace_id,teammate_id,workflow_alert_id) WHERE workflow_alert_id IS NOT NULL;

-- A trigger that fires from time or browsing fires once per occurrence (`trigger_key`: the
-- message not answered, the SLA target, the scheduled time, the page), and what a webhook sent
-- (or the page) is kept for the run's conditions.
ALTER TABLE workflow_runs ADD COLUMN trigger_key text;
ALTER TABLE workflow_runs ADD COLUMN trigger_data jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX workflow_runs_once ON workflow_runs(workspace_id,workflow_id,conversation_id,trigger_key) WHERE trigger_key IS NOT NULL;
CREATE INDEX workflow_runs_recent ON workflow_runs(workspace_id,workflow_id,started_at DESC);

-- A webhook's secret (only its hash) and a schedule's next time.
ALTER TABLE workflows ADD COLUMN hook_secret_hash text;
ALTER TABLE workflows ADD COLUMN schedule_next_at timestamptz;

-- The sweep checks time triggers at most once a minute per workspace.
CREATE TABLE workflow_ticks (
 workspace_id text NOT NULL, minute timestamptz NOT NULL, PRIMARY KEY(workspace_id,minute));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['workflow_alerts','workflow_ticks'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
