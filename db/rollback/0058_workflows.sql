-- Rollback for 0058_workflows: the flag goes off everywhere, so nothing triggers or resumes, and
-- runs in progress end as failed. The previous version ignores `sla_forced`, so SLAs go back to
-- their matching policy at the next change; it's cleared here so a later re-deploy starts clean.
-- Workflows, versions and run logs are kept.
UPDATE workspace_features SET enabled=false WHERE name='workflows_v1';
UPDATE workflow_runs SET status='failed',error='Stopped by rollback.',ended_at=now(),version=version+1 WHERE status IN ('running','waiting');
UPDATE conversations SET sla_forced=NULL WHERE sla_forced IS NOT NULL;
