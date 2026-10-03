-- Rollback for 0039_knowledge_health: the flag goes off everywhere, hiding the report and
-- stopping nightly checks. The tables stay (additive); the previous version never reads them.
-- A check left running is marked failed, so a later re-deploy starts a fresh one.
UPDATE workspace_features SET enabled=false WHERE name='knowledge_health_v1';
UPDATE knowledge_duplicate_runs SET status='failed',error='Stopped by rollback.',finished_at=now() WHERE status='running';
