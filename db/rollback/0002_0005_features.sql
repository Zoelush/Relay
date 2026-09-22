-- Roll back application exposure; retain identities, parts, job outcomes and audit records.
UPDATE workspace_features SET enabled=false
 WHERE workspace_id=current_setting('relay.workspace_id',true) AND name IN ('messenger_v2','conversations_v1','people_v1');
UPDATE messenger_sessions SET revoked_at=now(),version=version+1
 WHERE workspace_id=current_setting('relay.workspace_id',true) AND revoked_at IS NULL;
-- Disable RELAY_ENABLED and ATTACHMENTS_ENABLED in the native Worker as well.
-- In-flight jobs finish against this retained schema. Do not drop their tables or R2 objects.
