-- Data subject requests (phase 16, step C5a; docs/SECURITY_STEP7.md). Additive.
-- A request to export, or delete, everything about one person; and the append-only records'
-- triggers taught to allow exactly what a recorded deletion needs (the transaction setting
-- relay.erasure, which only the deletion sets): deleting a person's rows from logs kept for
-- them, and scrubbing them from ledgers others rely on, whose counts stay. Nothing else changes.

CREATE TABLE data_requests (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('export','delete')),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed')),
 -- Who it's about, while it runs: cleared when a deletion finishes, or an export expires.
 subject jsonb, label text,
 requested_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 error text, export_key text, export_expires_at timestamptz,
 counts jsonb, certificate jsonb,
 -- Storage keys a deletion still has to remove (ids, not personal data), cleared once removed.
 pending_objects jsonb,
 PRIMARY KEY(workspace_id,id));
CREATE INDEX data_requests_recent ON data_requests(workspace_id,created_at DESC);
ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON data_requests USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- The resolution ledger keeps a deleted person's rows (billing counts them) without their conversation.
ALTER TABLE ai_resolutions ALTER COLUMN conversation_id DROP NOT NULL;

-- Append-only rows (parts, delivery events, snapshots, changes, job events, ...): deleted only by a recorded deletion.
CREATE OR REPLACE FUNCTION reject_part_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' AND current_setting('relay.erasure',true) = 'on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Conversation parts are append-only';
END $$;
CREATE OR REPLACE FUNCTION keep_workflow_run_steps() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' AND current_setting('relay.erasure',true) = 'on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Workflow run steps are append-only';
END $$;
-- The ledger: only the person's links and text may be cleared; what billing counts stays as it was.
CREATE OR REPLACE FUNCTION keep_ai_resolutions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'UPDATE' AND current_setting('relay.erasure',true) = 'on' AND NEW.conversation_id IS NULL
   AND (NEW.id,NEW.kind,NEW.resolution_id,NEW.agent_id,NEW.rule,NEW.window_hours,NEW.recorded_at) IS NOT DISTINCT FROM (OLD.id,OLD.kind,OLD.resolution_id,OLD.agent_id,OLD.rule,OLD.window_hours,OLD.recorded_at)
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'The resolution ledger is append-only';
END $$;
-- The connector log: only the conversation, what was sent and what came back may be cleared.
CREATE OR REPLACE FUNCTION keep_ai_connector_calls() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'UPDATE' AND current_setting('relay.erasure',true) = 'on' AND NEW.conversation_id IS NULL
   AND (NEW.id,NEW.connector_id,NEW.version,NEW.source,NEW.invoked_by,NEW.method,NEW.status,NEW.attempts,NEW.duration_ms,NEW.result,NEW.created_at)
     IS NOT DISTINCT FROM (OLD.id,OLD.connector_id,OLD.version,OLD.source,OLD.invoked_by,OLD.method,OLD.status,OLD.attempts,OLD.duration_ms,OLD.result,OLD.created_at)
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'The connector audit is append-only';
END $$;
-- The audit log: a row about the person loses its target and details; who acted, what and when stay.
CREATE OR REPLACE FUNCTION keep_audit_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' AND current_setting('relay.audit_prune',true) = 'on' THEN RETURN OLD; END IF;
 IF TG_OP = 'UPDATE' AND current_setting('relay.erasure',true) = 'on'
   AND (NEW.seq,NEW.at,NEW.action,NEW.actor_type,NEW.actor_id,NEW.actor_name,NEW.via,NEW.target_type) IS NOT DISTINCT FROM (OLD.seq,OLD.at,OLD.action,OLD.actor_type,OLD.actor_id,OLD.actor_name,OLD.via,OLD.target_type)
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'The audit log is append-only';
END $$;
