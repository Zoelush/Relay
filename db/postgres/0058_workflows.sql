-- The workflow engine (phase 11, step W1; docs/WORKFLOWS_STEP1.md), behind `workflows_v1`. Additive.

-- A workflow: one trigger, and a graph of lettered paths stored as data (validated in code,
-- lib/workflow-definition.ts). `draft` is edited; publishing copies it into an immutable version,
-- and `live_version` is what new runs use. Within a trigger, `priority` orders them (0 first).
CREATE TABLE workflows (
 workspace_id text NOT NULL, id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 trigger text NOT NULL,
 priority integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','live','paused')),
 draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object'),
 live_version integer,
 archived boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 CHECK(state='draft' OR live_version IS NOT NULL));
CREATE UNIQUE INDEX workflows_name ON workflows(workspace_id,lower(name)) WHERE NOT archived;
CREATE INDEX workflows_live ON workflows(workspace_id,trigger,priority) WHERE state='live' AND NOT archived;

CREATE TABLE workflow_versions (
 workspace_id text NOT NULL, workflow_id text NOT NULL, version integer NOT NULL CHECK(version>=1),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 restored_from integer,
 published_by text NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,workflow_id,version),
 FOREIGN KEY(workspace_id,workflow_id) REFERENCES workflows(workspace_id,id));
CREATE FUNCTION keep_workflow_versions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Published workflow versions are never changed'; END $$;
CREATE TRIGGER immutable_workflow_versions BEFORE UPDATE OR DELETE ON workflow_versions FOR EACH ROW EXECUTE FUNCTION keep_workflow_versions();

-- One run per execution, on the version it started with. `chain` is the workflows whose changes
-- led to this run (loop detection); `skipped` runs record why a matching workflow didn't run.
CREATE TABLE workflow_runs (
 workspace_id text NOT NULL, id text NOT NULL, workflow_id text NOT NULL, workflow_version integer NOT NULL,
 conversation_id text, trigger text NOT NULL, trigger_part_id text,
 source text NOT NULL CHECK(source IN ('customer','teammate','zoe','workflow','system','manual')),
 chain text[] NOT NULL DEFAULT '{}',
 status text NOT NULL CHECK(status IN ('running','waiting','completed','failed','skipped')),
 path text, step integer NOT NULL DEFAULT 0,
 wait jsonb, wait_until timestamptz,
 nodes integer NOT NULL DEFAULT 0, steps integer NOT NULL DEFAULT 0,
 reason text NOT NULL DEFAULT '', error text NOT NULL DEFAULT '',
 started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, duration_ms integer,
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,id),
 CHECK((status IN ('running','waiting'))=(ended_at IS NULL)),
 CHECK(status<>'waiting' OR wait IS NOT NULL),
 FOREIGN KEY(workspace_id,workflow_id,workflow_version) REFERENCES workflow_versions(workspace_id,workflow_id,version),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE INDEX workflow_runs_workflow ON workflow_runs(workspace_id,workflow_id,started_at DESC);
CREATE INDEX workflow_runs_conversation ON workflow_runs(workspace_id,conversation_id,started_at DESC);
CREATE INDEX workflow_runs_due ON workflow_runs(workspace_id,wait_until) WHERE status='waiting';

-- Every node visited, condition evaluated (with its inputs) and action taken (with its result).
CREATE TABLE workflow_run_steps (
 workspace_id text NOT NULL, run_id text NOT NULL, seq integer NOT NULL,
 at timestamptz NOT NULL DEFAULT now(),
 path text, step integer,
 kind text NOT NULL CHECK(kind IN ('trigger','condition','action','branch','wait','goto','end','skip','error')),
 label text NOT NULL,
 inputs jsonb NOT NULL DEFAULT '{}', result text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
 duration_ms integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,run_id,seq),
 FOREIGN KEY(workspace_id,run_id) REFERENCES workflow_runs(workspace_id,id));
CREATE FUNCTION keep_workflow_run_steps() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Workflow run steps are append-only'; END $$;
CREATE TRIGGER immutable_workflow_run_steps BEFORE UPDATE OR DELETE ON workflow_run_steps FOR EACH ROW EXECUTE FUNCTION keep_workflow_run_steps();

-- A workflow's "apply an SLA" step: this policy (or none) instead of the matching one, until a
-- workflow clears it.
ALTER TABLE conversations ADD COLUMN sla_forced text;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['workflows','workflow_versions','workflow_runs','workflow_run_steps'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'workflows_v1',false FROM workspace ON CONFLICT DO NOTHING;
