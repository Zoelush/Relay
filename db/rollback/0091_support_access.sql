-- Rollback for 0091_support_access: every open grant is revoked and every staff session ended, so
-- no one from Relay's support can reach the workspace (the earlier code has no way for them to).
-- The tables and their history stay.
UPDATE support_sessions SET revoked_at=now(),revoked_reason='Support access was rolled back.' WHERE revoked_at IS NULL;
UPDATE support_grants SET revoked_at=now(),revoked_by='rollback',revoked_by_name='Rollback' WHERE revoked_at IS NULL;
