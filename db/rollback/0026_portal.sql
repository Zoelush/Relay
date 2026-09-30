-- Rollback for 0026_portal: additive, so nothing is dropped. Turning `portal_v1` off makes
-- every portal route refuse; the previous version has no portal routes at all. Revoking the
-- sessions ends any signed-in portal immediately.
UPDATE workspace_features SET enabled=false WHERE name='portal_v1';
UPDATE portal_sessions SET revoked_at=now() WHERE revoked_at IS NULL;
