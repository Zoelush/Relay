-- Rollback for 0083_teammate_accounts: every password session ends and open invitations are withdrawn,
-- so only the hosting platform's sign-in works. The tables and the audit log's records stay.
UPDATE teammate_sessions SET revoked_at=now(),revoked_reason='Rolled back.' WHERE revoked_at IS NULL;
UPDATE teammate_invitations SET revoked_at=now() WHERE accepted_at IS NULL AND revoked_at IS NULL;
UPDATE email_alerts SET link_sealed=NULL WHERE link_sealed IS NOT NULL;
