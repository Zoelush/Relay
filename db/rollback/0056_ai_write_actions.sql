-- Rollback for 0056_ai_write_actions: the previous version doesn't know write connectors and would
-- call one like a read, so every write connector is archived (it refuses archived connectors, and
-- its procedures can't compile or run against them). Writes are turned off and every workspace
-- paused, for when this step is deployed again; pending approvals are cancelled and the procedures
-- waiting on them ended. Restoring a write connector afterwards is a deliberate, by-hand step.
UPDATE ai_connectors SET writes_enabled=false,archived=true,version=version+1,updated_at=now() WHERE access='write';
UPDATE ai_agents SET writes_paused=true,writes_paused_at=now() WHERE NOT writes_paused;
UPDATE ai_action_approvals SET status='cancelled',decided_at=now(),note='Stopped by rollback.',version=version+1 WHERE status='pending';
UPDATE ai_procedure_runs SET status='abandoned',reason='Stopped by rollback.',ended_at=now(),updated_at=now(),version=version+1 WHERE status='waiting' AND waiting_for LIKE 'approval:%';
