-- Rollback for 0038_workspace_data: the archived_at column stays (additive) and the previous
-- version ignores it, so archived tags show in its pickers again. The delete guard stays too: no
-- previous version deletes tags.
SELECT 1;
