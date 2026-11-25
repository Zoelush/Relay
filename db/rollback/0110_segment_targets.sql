-- Rollback for 0110_segment_targets: company segments are archived first, so the earlier code (which
-- reads every segment as people) never counts or sends to one. Definitions with groups, tags or
-- company rules are refused by the earlier code's checks when edited, and match nobody it can explain.
UPDATE segments SET archived_at=COALESCE(archived_at,now()) WHERE target='companies';
ALTER TABLE segments DROP COLUMN target;
