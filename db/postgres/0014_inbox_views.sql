-- Inbox-owned saved views and materialized membership. No earlier migration changes.
CREATE TABLE inbox_view_folders (
 workspace_id text NOT NULL, id text NOT NULL, owner_id text NOT NULL, name text NOT NULL,
 shared boolean NOT NULL DEFAULT false, position integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), origin_timezone text NOT NULL DEFAULT 'UTC',
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES teammates(workspace_id,id)
);
CREATE TABLE inbox_views (
 workspace_id text NOT NULL, id text NOT NULL, owner_id text NOT NULL, name text NOT NULL,
 shared boolean NOT NULL DEFAULT false, folder_id text, position integer NOT NULL DEFAULT 0,
 filter jsonb NOT NULL, sort text NOT NULL DEFAULT 'newest' CHECK(sort IN ('newest','oldest','waiting')),
 builtin text, archived boolean NOT NULL DEFAULT false, revision bigint NOT NULL DEFAULT 1,
 match_count bigint NOT NULL DEFAULT 0 CHECK(match_count>=0), count_version bigint NOT NULL DEFAULT 0,
 ready boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), origin_timezone text NOT NULL DEFAULT 'UTC',
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES teammates(workspace_id,id),
 FOREIGN KEY(workspace_id,folder_id) REFERENCES inbox_view_folders(workspace_id,id)
);
CREATE UNIQUE INDEX inbox_builtin ON inbox_views(workspace_id,owner_id,builtin) WHERE builtin IS NOT NULL;
CREATE TABLE inbox_view_memberships (
 workspace_id text NOT NULL, view_id text NOT NULL, conversation_id text NOT NULL,
 PRIMARY KEY(workspace_id,view_id,conversation_id),
 FOREIGN KEY(workspace_id,view_id) REFERENCES inbox_views(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE INDEX inbox_membership_reverse ON inbox_view_memberships(workspace_id,conversation_id,view_id);
CREATE TABLE inbox_projection_dirty (
 workspace_id text NOT NULL, conversation_id text NOT NULL, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,conversation_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE FUNCTION relay_inbox_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w text; cid text;
BEGIN
 IF TG_TABLE_NAME='conversations' THEN w:=NEW.workspace_id; cid:=NEW.id;
 ELSIF TG_OP='DELETE' THEN w:=OLD.workspace_id; cid:=OLD.conversation_id;
 ELSE w:=NEW.workspace_id; cid:=NEW.conversation_id; END IF;
 INSERT INTO inbox_projection_dirty(workspace_id,conversation_id) VALUES(w,cid)
 ON CONFLICT(workspace_id,conversation_id) DO UPDATE SET version=inbox_projection_dirty.version+1;
 RETURN NULL;
END $$;
CREATE TRIGGER inbox_conversation_dirty AFTER INSERT OR UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION relay_inbox_dirty();
CREATE TRIGGER inbox_tag_dirty AFTER INSERT OR DELETE ON conversation_tags FOR EACH ROW EXECUTE FUNCTION relay_inbox_dirty();
CREATE FUNCTION relay_inbox_member_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
 UPDATE inbox_views SET match_count=match_count+1,count_version=count_version+1 WHERE workspace_id=NEW.workspace_id AND id=NEW.view_id;
 ELSE
 UPDATE inbox_views SET match_count=match_count-1,count_version=count_version+1 WHERE workspace_id=OLD.workspace_id AND id=OLD.view_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER inbox_member_count AFTER INSERT OR DELETE ON inbox_view_memberships FOR EACH ROW EXECUTE FUNCTION relay_inbox_member_count();
CREATE INDEX inbox_created_order ON conversations(workspace_id,created_at DESC,id DESC) WHERE merged_into_id IS NULL;
CREATE INDEX inbox_waiting_order ON conversations(workspace_id,last_contact_reply_at,id) WHERE merged_into_id IS NULL;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'agent_inbox_views_v1',false FROM workspace ON CONFLICT DO NOTHING;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['inbox_view_folders','inbox_views','inbox_view_memberships','inbox_projection_dirty'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
CREATE UNIQUE INDEX inbox_projection_active_job ON jobs(workspace_id,kind) WHERE kind='inbox.views.project' AND state IN ('queued','running');
