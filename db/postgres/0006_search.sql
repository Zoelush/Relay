CREATE TABLE conversation_tags (
 workspace_id text NOT NULL,conversation_id text NOT NULL,tag_id text NOT NULL,
 PRIMARY KEY(workspace_id,conversation_id,tag_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,tag_id) REFERENCES tags(workspace_id,id)
);
ALTER TABLE conversation_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON conversation_tags USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE INDEX conversation_tag_filter ON conversation_tags(workspace_id,tag_id,conversation_id);
CREATE INDEX conversation_state_filter ON conversations(workspace_id,status,updated_at DESC,id) WHERE merged_into_id IS NULL;
CREATE INDEX conversation_assignee_filter ON conversations(workspace_id,assigned,updated_at DESC,id) WHERE merged_into_id IS NULL;
CREATE INDEX conversation_team_filter ON conversations(workspace_id,team_id,updated_at DESC,id) WHERE merged_into_id IS NULL;
CREATE INDEX conversation_identity_filter ON conversations(workspace_id,primary_identity_id,updated_at DESC,id);
CREATE INDEX part_superseding ON conversation_parts(workspace_id,supersedes_id) WHERE supersedes_id IS NOT NULL;
