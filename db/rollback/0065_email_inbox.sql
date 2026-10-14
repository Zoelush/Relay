-- Rollback for 0065_email_inbox, with E3's code back: Zoe stops answering email, and what E3's
-- code can't handle ends. Held drafts and side conversations' unsent messages fail, queued
-- incident alerts fail, and live workflows that use the email trigger or step are paused (E3's
-- code refuses them). Side conversations, their messages and the widened checks stay, so a
-- re-deploy finds them as they were.
UPDATE ai_agents SET email_mode='off';
UPDATE channel_deliveries SET status='failed',error='Stopped by rollback.' WHERE status='held' OR (purpose='side' AND status='queued');
UPDATE email_alerts SET status='failed',error='Stopped by rollback.',updated_at=now() WHERE status='queued';
UPDATE workflows SET state='paused',updated_at=now() WHERE state='live' AND (trigger='email_received' OR EXISTS (
  SELECT 1 FROM workflow_versions v WHERE v.workspace_id=workflows.workspace_id AND v.workflow_id=workflows.id AND v.version=workflows.live_version
  AND jsonb_path_exists(v.definition,'$.paths[*].steps[*] ? (@.type == "email")')));
