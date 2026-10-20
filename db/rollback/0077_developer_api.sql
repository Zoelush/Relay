-- Rollback for 0077_developer_api: the flag goes off, so every token is refused and the
-- Developers page closes. The tables stay (tokens can't be used while it's off).
UPDATE workspace_features SET enabled=false WHERE name='developer_api_v1';
