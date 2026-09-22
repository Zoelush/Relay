ALTER TABLE conversations ADD COLUMN calendar_id text;
ALTER TABLE conversations ADD COLUMN calendar_version integer;
ALTER TABLE conversations ADD COLUMN first_response_business_ms bigint;
ALTER TABLE conversations ADD CONSTRAINT conversation_calendar FOREIGN KEY(workspace_id,calendar_id,calendar_version) REFERENCES business_calendars(workspace_id,id,version);
CREATE TABLE job_events (
 workspace_id text NOT NULL,job_id text NOT NULL,version bigint NOT NULL,state text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),origin_timezone text NOT NULL DEFAULT 'UTC',
 PRIMARY KEY(workspace_id,job_id,version),FOREIGN KEY(workspace_id,job_id) REFERENCES jobs(workspace_id,id)
);
ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;ALTER TABLE job_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON job_events USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE TRIGGER immutable_job_events BEFORE UPDATE OR DELETE ON job_events FOR EACH ROW EXECUTE FUNCTION reject_part_mutation();
CREATE FUNCTION record_job_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO job_events(workspace_id,job_id,version,state) VALUES(NEW.workspace_id,NEW.id,NEW.version,NEW.state) ON CONFLICT DO NOTHING;
 INSERT INTO outbox(workspace_id,id,kind,resource_id,payload) VALUES(NEW.workspace_id,NEW.id||':'||NEW.version,'job_status',NEW.id,jsonb_build_object('version',NEW.version)) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER job_state_event AFTER INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION record_job_state();
