-- Business calendars (phase 05, step B1): a named calendar points at its current published
-- version (versions stay immutable), and a calendar can be assigned as the workspace default,
-- to a brand or to a team. Resolution: team, then brand, then workspace, then 24/7. Additive.
ALTER TABLE business_calendars ADD COLUMN published_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE calendars (
 workspace_id text NOT NULL, id text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 current_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,id,current_version) REFERENCES business_calendars(workspace_id,id,version));
-- Calendars that predate names get their id as their name, pointing at their latest version.
INSERT INTO calendars(workspace_id,id,name,current_version)
 SELECT workspace_id,id,left(id,80),max(version) FROM business_calendars GROUP BY workspace_id,id;
CREATE TABLE calendar_assignments (
 workspace_id text NOT NULL, scope text NOT NULL CHECK(scope IN ('workspace','brand','team')),
 scope_id text NOT NULL, calendar_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,scope,scope_id), CHECK((scope='workspace')=(scope_id='')),
 FOREIGN KEY(workspace_id,calendar_id) REFERENCES calendars(workspace_id,id));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['calendars','calendar_assignments'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
-- SLAs (steps B1 and B2) ship behind their own flag, off for every workspace.
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'sla_v1',false FROM workspace ON CONFLICT DO NOTHING;
