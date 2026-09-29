-- Exposure rollback: hide views for this workspace. Keep filter sets, members and
-- saved view definitions; nothing is dropped or renamed.
UPDATE workspace_features SET enabled=false WHERE workspace_id=current_setting('relay.workspace_id',true) AND name='agent_inbox_views_v1';
-- If the application is also rolled back to the pre-0015 version, that version reads
-- inbox_view_memberships, which this version stops maintaining. Before re-enabling views
-- on it, save each view or run its rebuild so memberships are recomputed.
-- Views created by that older version have no set_id; this version's "initialize"
-- action attaches them to a set and rebuilds it.
