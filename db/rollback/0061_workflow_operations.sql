-- Rollback for 0061_workflow_operations: the previous version has no alerts, time or webhook
-- triggers, or reusable workflows. Open alerts close and their notifications go (it would show them
-- as Zoe's incidents). Live workflows using the new triggers, or passing to a reusable workflow,
-- are paused, and webhook secrets are cleared so no call is accepted. Runs and their logs stay.
UPDATE workflow_alerts SET resolved_at=now(),resolution='rolled_back' WHERE resolved_at IS NULL;
DELETE FROM notifications WHERE kind='workflow_alert';
UPDATE workflows SET hook_secret_hash=NULL,schedule_next_at=NULL WHERE hook_secret_hash IS NOT NULL OR schedule_next_at IS NOT NULL;
UPDATE workflows SET state='paused',version=version+1,updated_at=now()
 WHERE state='live' AND (trigger IN ('schedule','unresponsive','sla_before_breach','page_visit','webhook','reusable') OR EXISTS(
   SELECT 1 FROM workflow_versions v, jsonb_array_elements(v.definition->'paths') p
   WHERE v.workspace_id=workflows.workspace_id AND v.workflow_id=workflows.id AND v.version=workflows.live_version
     AND p->'next'->>'type'='workflow'));
