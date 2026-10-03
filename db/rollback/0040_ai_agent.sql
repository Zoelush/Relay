-- Rollback for 0040_ai_agent: the flag goes off everywhere, so no new answers are queued and
-- queued ones skip. The tables, the passages' keyword column and its trigger stay (additive);
-- the previous version never reads them.
UPDATE workspace_features SET enabled=false WHERE name='ai_agent_v1';
