-- Rollback for 0085_sso: single sign-on is turned off (enforcement first) and SSO sessions end, so
-- only password and platform sign-in work, as the earlier code expects. Teammates made by SSO keep
-- their records, and a manager can send them a password reset. The tables and audit records stay.
UPDATE sso_connections SET enforced=false,enabled=false WHERE enabled OR enforced;
UPDATE teammate_sessions SET revoked_at=now(),revoked_reason='Rolled back.' WHERE method='sso' AND revoked_at IS NULL;
UPDATE sso_logins SET used_at=now() WHERE used_at IS NULL;
