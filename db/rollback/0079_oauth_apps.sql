-- Rollback for 0079_oauth_apps: every installation is revoked and every app token expires now,
-- so no app can reach a workspace. The tables stay (apps can be installed again afterwards).
UPDATE oauth_grants SET revoked_at=now(),revoked_reason='Rolled back.' WHERE revoked_at IS NULL;
UPDATE api_tokens SET revoked_at=now() WHERE grant_id IS NOT NULL AND revoked_at IS NULL;
