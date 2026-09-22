-- Run with relay.workspace_id set in a tenant transaction.
UPDATE workspace_features SET enabled=false
 WHERE workspace_id=current_setting('relay.workspace_id',true) AND name='agent_inbox_v1';
-- Retain audience, owners and the note constraint. Never roll back privacy.
-- UI rollback: RELAY_AGENT_INBOX_V1=false. Keep PostgreSQL write authority;
-- D1 writes require a separately verified reverse-copy/cutover, not this flag.
