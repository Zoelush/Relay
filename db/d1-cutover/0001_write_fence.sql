-- Separate source migration; apply only to the existing single-workspace D1 database.
-- This does NOT change authority. Old deployments are fenced by database triggers too.
CREATE TABLE IF NOT EXISTS relay_write_fence (
 workspace_id TEXT PRIMARY KEY,
 authority TEXT NOT NULL DEFAULT 'd1' CHECK(authority IN ('d1','frozen','postgres')),
 epoch INTEGER NOT NULL DEFAULT 0,
 changed_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO relay_write_fence(workspace_id,authority,changed_at) VALUES('main','d1',unixepoch()*1000);
CREATE TRIGGER IF NOT EXISTS fence_workspace_insert BEFORE INSERT ON workspace WHEN (SELECT authority FROM relay_write_fence WHERE workspace_id='main')<>'d1' BEGIN SELECT RAISE(ABORT,'RELAY_STORAGE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS fence_workspace_update BEFORE UPDATE ON workspace WHEN (SELECT authority FROM relay_write_fence WHERE workspace_id='main')<>'d1' BEGIN SELECT RAISE(ABORT,'RELAY_STORAGE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS fence_workspace_delete BEFORE DELETE ON workspace WHEN (SELECT authority FROM relay_write_fence WHERE workspace_id='main')<>'d1' BEGIN SELECT RAISE(ABORT,'RELAY_STORAGE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS fence_conversation_insert BEFORE INSERT ON conversations WHEN (SELECT authority FROM relay_write_fence WHERE workspace_id='main')<>'d1' BEGIN SELECT RAISE(ABORT,'RELAY_STORAGE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS fence_conversation_update BEFORE UPDATE ON conversations WHEN (SELECT authority FROM relay_write_fence WHERE workspace_id='main')<>'d1' BEGIN SELECT RAISE(ABORT,'RELAY_STORAGE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS fence_conversation_delete BEFORE DELETE ON conversations WHEN (SELECT authority FROM relay_write_fence WHERE workspace_id='main')<>'d1' BEGIN SELECT RAISE(ABORT,'RELAY_STORAGE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS fence_message_insert BEFORE INSERT ON messages WHEN (SELECT authority FROM relay_write_fence WHERE workspace_id='main')<>'d1' BEGIN SELECT RAISE(ABORT,'RELAY_STORAGE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS fence_message_update BEFORE UPDATE ON messages WHEN (SELECT authority FROM relay_write_fence WHERE workspace_id='main')<>'d1' BEGIN SELECT RAISE(ABORT,'RELAY_STORAGE_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS fence_message_delete BEFORE DELETE ON messages WHEN (SELECT authority FROM relay_write_fence WHERE workspace_id='main')<>'d1' BEGIN SELECT RAISE(ABORT,'RELAY_STORAGE_FROZEN'); END;
