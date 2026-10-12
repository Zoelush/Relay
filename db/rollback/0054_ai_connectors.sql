-- Rollback for 0054_ai_connectors: the flag goes off everywhere, so no connector can be edited,
-- tested or called. Connectors, versions, encrypted secrets and the audit stay (additive; the
-- audit is evidence). Cached OAuth tokens are dropped, since nothing will refresh them.
UPDATE workspace_features SET enabled=false WHERE name='ai_actions_v1';
DELETE FROM ai_connector_tokens;
