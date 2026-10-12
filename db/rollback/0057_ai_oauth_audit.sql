-- Rollback for 0057_ai_oauth_audit: the previous version doesn't know OAuth on the workspace's
-- behalf, so connections in progress are dropped and connectors using it are archived (it would
-- refuse their definitions' auth anyway). Refresh tokens stay encrypted, for a later re-deploy.
DELETE FROM ai_connector_oauth_states;
UPDATE ai_connectors SET archived=true,writes_enabled=false,version=version+1,updated_at=now()
 WHERE draft->'auth'->>'type'='oauth_authorization_code'
    OR EXISTS(SELECT 1 FROM ai_connector_versions v WHERE v.workspace_id=ai_connectors.workspace_id AND v.connector_id=ai_connectors.id AND v.definition->'auth'->>'type'='oauth_authorization_code');
