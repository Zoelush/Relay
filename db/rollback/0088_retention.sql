-- Rollback for 0088_retention: every policy goes back to keep (nothing more is deleted), and the
-- append-only triggers accept only a data request's deletion again, as after 0087. Expired files
-- stay expired (their bytes are gone) and the status check keeps allowing them.
UPDATE retention_settings SET conversations_days=NULL,attachments_days=NULL,recordings_days=NULL,events_days=NULL,logs_days=NULL;
CREATE OR REPLACE FUNCTION reject_part_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' AND current_setting('relay.erasure',true) = 'on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Conversation parts are append-only';
END $$;
CREATE OR REPLACE FUNCTION keep_workflow_run_steps() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' AND current_setting('relay.erasure',true) = 'on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Workflow run steps are append-only';
END $$;
CREATE OR REPLACE FUNCTION keep_ai_connector_calls() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'UPDATE' AND current_setting('relay.erasure',true) = 'on' AND NEW.conversation_id IS NULL
   AND (NEW.id,NEW.connector_id,NEW.version,NEW.source,NEW.invoked_by,NEW.method,NEW.status,NEW.attempts,NEW.duration_ms,NEW.result,NEW.created_at)
     IS NOT DISTINCT FROM (OLD.id,OLD.connector_id,OLD.version,OLD.source,OLD.invoked_by,OLD.method,OLD.status,OLD.attempts,OLD.duration_ms,OLD.result,OLD.created_at)
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'The connector audit is append-only';
END $$;
