-- Server-backed drafts, visible only to their author. One draft per conversation, teammate
-- and mode. `version` is the optimistic-concurrency token for autosave from several tabs.
CREATE TABLE conversation_drafts (
 workspace_id text NOT NULL, conversation_id text NOT NULL, teammate_id text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('reply','note')), doc jsonb NOT NULL, body text NOT NULL,
 version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), origin_timezone text,
 PRIMARY KEY(workspace_id,conversation_id,teammate_id,mode),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id)
);
-- Retention: drafts untouched for 30 days are purged by the workspace sweep.
CREATE INDEX conversation_drafts_age ON conversation_drafts(workspace_id,updated_at);
ALTER TABLE conversation_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON conversation_drafts USING (workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK (workspace_id=current_setting('relay.workspace_id',true));
