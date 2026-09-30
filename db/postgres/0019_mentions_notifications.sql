-- Mentions and in-app notifications. Additive.
-- One row per mentioned teammate per note part (teams are expanded to members at send).
CREATE TABLE conversation_mentions (
 workspace_id text NOT NULL, conversation_id text NOT NULL, part_id text NOT NULL, teammate_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,part_id,teammate_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,part_id) REFERENCES conversation_parts(workspace_id,id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id)
);
CREATE INDEX conversation_mentions_by_teammate ON conversation_mentions(workspace_id,teammate_id,conversation_id);
-- The Mentions view is a filter over these rows; a new mention re-evaluates its conversation.
CREATE TRIGGER inbox_mention_dirty AFTER INSERT ON conversation_mentions FOR EACH ROW EXECUTE FUNCTION relay_inbox_dirty();
-- Notifications belong to one teammate and are only ever read with that teammate's id.
CREATE TABLE notifications (
 workspace_id text NOT NULL, id text NOT NULL, teammate_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('mention')),
 conversation_id text NOT NULL, part_id text NOT NULL, actor_teammate_id text NOT NULL,
 excerpt text NOT NULL DEFAULT '' CHECK(length(excerpt)<=140),
 created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,teammate_id,part_id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_teammate_id) REFERENCES teammates(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,part_id) REFERENCES conversation_parts(workspace_id,id)
);
CREATE INDEX notifications_inbox ON notifications(workspace_id,teammate_id,created_at DESC,id DESC);
CREATE INDEX notifications_unread ON notifications(workspace_id,teammate_id) WHERE read_at IS NULL;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['conversation_mentions','notifications'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
