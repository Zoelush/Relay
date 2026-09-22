ALTER TABLE messenger_sessions ADD COLUMN origin_timezone text;
CREATE INDEX session_identity_active ON messenger_sessions(workspace_id,identity_id,expires_at) WHERE revoked_at IS NULL;
