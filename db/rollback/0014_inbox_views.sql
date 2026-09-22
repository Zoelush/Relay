-- Exposure rollback only. Preserve saved definitions/memberships and writer authority.
UPDATE workspace_features SET enabled=false WHERE workspace_id=current_setting('relay.workspace_id',true) AND name='agent_inbox_views_v1';
