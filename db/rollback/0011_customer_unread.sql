-- Execute in a transaction with relay.workspace_id set to the affected workspace.
-- Roll back exposure, not retained read positions, identity mappings or history.
UPDATE workspace_features SET enabled=false
 WHERE workspace_id=current_setting('relay.workspace_id',true) AND name='messenger_v2';
UPDATE messenger_sessions SET revoked_at=now(),version=version+1
 WHERE workspace_id=current_setting('relay.workspace_id',true) AND revoked_at IS NULL;
-- Leave both generations of unread projections in place. Finish/repair the
-- customer.unread.rebuild job before re-enabling the canonical reader.
