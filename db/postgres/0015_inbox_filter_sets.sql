-- Shared view membership. Views with the same filter (every teammate's "All open", for
-- example) share one filter set: one member list, one count, one rebuild. A state change
-- then writes a handful of member rows instead of one per teammate per view.
-- Additive: inbox_view_memberships and inbox_views.match_count are retained, unused.
CREATE TABLE inbox_filter_sets (
 workspace_id text NOT NULL, id text NOT NULL, filter jsonb NOT NULL,
 match_count bigint NOT NULL DEFAULT 0 CHECK(match_count>=0), count_version bigint NOT NULL DEFAULT 0,
 ready boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id)
);
-- Members carry the list sort keys so a page is one index range of 101 rows.
CREATE TABLE inbox_filter_members (
 workspace_id text NOT NULL, set_id text NOT NULL, conversation_id text NOT NULL,
 created_at timestamptz NOT NULL, waiting_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,set_id,conversation_id),
 FOREIGN KEY(workspace_id,set_id) REFERENCES inbox_filter_sets(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE INDEX inbox_filter_newest ON inbox_filter_members(workspace_id,set_id,created_at,conversation_id);
CREATE INDEX inbox_filter_waiting ON inbox_filter_members(workspace_id,set_id,waiting_at,conversation_id);
ALTER TABLE inbox_views ADD COLUMN set_id text;
ALTER TABLE inbox_views ADD CONSTRAINT inbox_view_set FOREIGN KEY(workspace_id,set_id) REFERENCES inbox_filter_sets(workspace_id,id);
CREATE INDEX inbox_views_by_set ON inbox_views(workspace_id,set_id) WHERE NOT archived;
-- One count update per set per statement, not one per member row.
CREATE FUNCTION relay_inbox_set_added() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE inbox_filter_sets s SET match_count=s.match_count+d.n,count_version=s.count_version+1
 FROM (SELECT workspace_id,set_id,count(*) AS n FROM added GROUP BY workspace_id,set_id) d
 WHERE s.workspace_id=d.workspace_id AND s.id=d.set_id;
 RETURN NULL;
END $$;
CREATE FUNCTION relay_inbox_set_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE inbox_filter_sets s SET match_count=s.match_count-d.n,count_version=s.count_version+1
 FROM (SELECT workspace_id,set_id,count(*) AS n FROM removed GROUP BY workspace_id,set_id) d
 WHERE s.workspace_id=d.workspace_id AND s.id=d.set_id;
 RETURN NULL;
END $$;
CREATE TRIGGER inbox_set_added AFTER INSERT ON inbox_filter_members
 REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION relay_inbox_set_added();
CREATE TRIGGER inbox_set_removed AFTER DELETE ON inbox_filter_members
 REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION relay_inbox_set_removed();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['inbox_filter_sets','inbox_filter_members'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
-- Set ids are derived in SQL from the normalized jsonb text, so equal filters share a set.
INSERT INTO inbox_filter_sets(workspace_id,id,filter)
 SELECT DISTINCT workspace_id,encode(sha256(convert_to(filter::text,'UTF8')),'hex'),filter FROM inbox_views
 ON CONFLICT DO NOTHING;
UPDATE inbox_views SET set_id=encode(sha256(convert_to(filter::text,'UTF8')),'hex') WHERE set_id IS NULL;
