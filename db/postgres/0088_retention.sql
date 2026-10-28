-- Retention policies (phase 16, step C6a; docs/SECURITY_STEP9.md). Additive.
-- One policy per kind of data (conversations, attachments, call recordings, events, logs): keep
-- (NULL, the default) or a number of days from 30 to 7 years. The sweep applies them in batches,
-- and the append-only logs accept a retention deletion only during a run (relay.retention, which
-- only the retention job sets), as they accept a deletion's for a data request (relay.erasure).

CREATE TABLE retention_settings (
 workspace_id text PRIMARY KEY REFERENCES workspace(id),
 conversations_days int CHECK(conversations_days BETWEEN 30 AND 2557),
 attachments_days int CHECK(attachments_days BETWEEN 30 AND 2557),
 recordings_days int CHECK(recordings_days BETWEEN 30 AND 2557),
 events_days int CHECK(events_days BETWEEN 30 AND 2557),
 logs_days int CHECK(logs_days BETWEEN 30 AND 2557),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
 last_run_at timestamptz, last_result jsonb,
 -- A run's files, report rows and Twilio records still to remove (ids, not personal data).
 pending jsonb);
ALTER TABLE retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON retention_settings USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
-- In the audit log: the policies (each run is recorded by the job).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OF conversations_days,attachments_days,recordings_days,events_days,logs_days ON retention_settings FOR EACH ROW EXECUTE FUNCTION audit_row('retention','workspace','workspace_id','');

-- A file past its workspace's retention: deleted from storage, its record kept as expired.
ALTER TABLE attachments DROP CONSTRAINT attachments_status_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_status_check CHECK(status IN ('pending','scanning','clean','rejected','failed','expired'));

-- Append-only rows: deleted only by a data request's deletion or a retention run.
CREATE OR REPLACE FUNCTION reject_part_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' AND (current_setting('relay.erasure',true) = 'on' OR current_setting('relay.retention',true) = 'on') THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Conversation parts are append-only';
END $$;
CREATE OR REPLACE FUNCTION keep_workflow_run_steps() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' AND (current_setting('relay.erasure',true) = 'on' OR current_setting('relay.retention',true) = 'on') THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Workflow run steps are append-only';
END $$;
CREATE OR REPLACE FUNCTION keep_ai_connector_calls() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' AND current_setting('relay.retention',true) = 'on' THEN RETURN OLD; END IF;
 IF TG_OP = 'UPDATE' AND current_setting('relay.erasure',true) = 'on' AND NEW.conversation_id IS NULL
   AND (NEW.id,NEW.connector_id,NEW.version,NEW.source,NEW.invoked_by,NEW.method,NEW.status,NEW.attempts,NEW.duration_ms,NEW.result,NEW.created_at)
     IS NOT DISTINCT FROM (OLD.id,OLD.connector_id,OLD.version,OLD.source,OLD.invoked_by,OLD.method,OLD.status,OLD.attempts,OLD.duration_ms,OLD.result,OLD.created_at)
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'The connector audit is append-only';
END $$;
