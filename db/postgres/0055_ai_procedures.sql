-- Procedures for Zoe (phase 09, step D2; docs/ACTIONS_STEP2.md), behind `ai_actions_v1`. Additive.

-- A procedure: what starts it (keywords, checked in code), what to collect, and plain-language
-- steps. `source` is the draft; publishing compiles it into a fixed plan in an immutable version.
CREATE TABLE ai_procedures (
 workspace_id text NOT NULL, id text NOT NULL, agent_id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
 source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'),
 live_version integer,
 archived boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES ai_agents(workspace_id,id));
CREATE UNIQUE INDEX ai_procedures_name ON ai_procedures(workspace_id,lower(name)) WHERE NOT archived;

CREATE TABLE ai_procedure_versions (
 workspace_id text NOT NULL, procedure_id text NOT NULL, version integer NOT NULL CHECK(version>=1),
 source jsonb NOT NULL, plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
 published_by text NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,procedure_id,version),
 FOREIGN KEY(workspace_id,procedure_id) REFERENCES ai_procedures(workspace_id,id));
CREATE FUNCTION keep_ai_procedure_versions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Published procedure versions are never changed'; END $$;
CREATE TRIGGER immutable_ai_procedure_versions BEFORE UPDATE OR DELETE ON ai_procedure_versions FOR EACH ROW EXECUTE FUNCTION keep_ai_procedure_versions();

-- A procedure running in a conversation, on the version it started with: the step it's at, the
-- input it's waiting for, and the values gathered and looked up. One at a time per conversation.
CREATE TABLE ai_procedure_runs (
 workspace_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL,
 procedure_id text NOT NULL, procedure_version integer NOT NULL,
 status text NOT NULL CHECK(status IN ('waiting','resolved','escalated','abandoned')),
 step integer NOT NULL DEFAULT 0, waiting_for text, retries integer NOT NULL DEFAULT 0,
 "values" jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof("values")='object'),
 reason text NOT NULL DEFAULT '',
 started_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,id),
 CHECK((status='waiting')=(ended_at IS NULL)),
 FOREIGN KEY(workspace_id,procedure_id,procedure_version) REFERENCES ai_procedure_versions(workspace_id,procedure_id,version),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE UNIQUE INDEX ai_procedure_runs_active ON ai_procedure_runs(workspace_id,conversation_id) WHERE status='waiting';

-- Every turn a procedure took is an answer record, with its run.
ALTER TABLE ai_answers DROP CONSTRAINT ai_answers_outcome_check;
ALTER TABLE ai_answers ADD CONSTRAINT ai_answers_outcome_check
 CHECK(outcome IN ('answered','clarified','unknown','skipped','failed','escalated','procedure'));
ALTER TABLE ai_answers ADD COLUMN procedure_run_id text;

-- How a customer must be verified before any connector runs: rules in order (conditions as in
-- escalation rules, on a channel), the first that matches deciding; otherwise the fallback.
-- Signed in means the website verified who they are (the messenger's signed identity).
ALTER TABLE ai_agents
 ADD COLUMN verification_rules jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(verification_rules)='array'),
 ADD COLUMN verification_fallback text NOT NULL DEFAULT 'signed_in' CHECK(verification_fallback IN ('signed_in','none'));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ai_procedures','ai_procedure_versions','ai_procedure_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
