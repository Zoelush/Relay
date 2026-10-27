-- Rollback for 0087_data_requests: the append-only triggers go back to refusing every change, and
-- requests still running are marked failed. The requests table, its certificates and the ledger's
-- nullable conversation stay, as rows already scrubbed can't be put back.
CREATE OR REPLACE FUNCTION reject_part_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Conversation parts are append-only'; END $$;
CREATE OR REPLACE FUNCTION keep_workflow_run_steps() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Workflow run steps are append-only'; END $$;
CREATE OR REPLACE FUNCTION keep_ai_resolutions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'The resolution ledger is append-only'; END $$;
CREATE OR REPLACE FUNCTION keep_ai_connector_calls() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'The connector audit is append-only'; END $$;
CREATE OR REPLACE FUNCTION keep_audit_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' AND current_setting('relay.audit_prune',true) = 'on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'The audit log is append-only';
END $$;
UPDATE data_requests SET state='failed',error='Rolled back.',finished_at=now() WHERE state IN ('queued','running');
