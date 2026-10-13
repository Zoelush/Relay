-- Rollback for 0060_workflow_customer_steps: the previous version can't run customer-facing steps,
-- so runs waiting for a customer's answer or Zoe's outcome end as failed, and live workflows that
-- talk to customers are paused (a manager publishes them again after a re-deploy). Workflow
-- messages already sent stay in their timelines, and the widened checks stay because rows use
-- them. The previous version shows no part of a kind it doesn't know.
UPDATE workflow_runs SET status='failed',error='Stopped by rollback.',ended_at=now(),version=version+1
 WHERE status IN ('running','waiting') AND wait->>'kind' IN ('reply','zoe');
UPDATE workflows SET state='paused',version=version+1,updated_at=now()
 WHERE state='live' AND EXISTS(
   SELECT 1 FROM workflow_versions v, jsonb_array_elements(v.definition->'paths') p
   WHERE v.workspace_id=workflows.workspace_id AND v.workflow_id=workflows.id AND v.version=workflows.live_version
     AND (p->'next'->>'type' IN ('buttons','zoe','connector')
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'steps') s WHERE s->>'type' IN ('message','reply_time','collect'))));
