-- Rollback for 0074_reporting_sources: the flag goes off, so the projection stops and the
-- reporting pages close. The triggers stay (they only add rows), and so do the snapshots.
UPDATE workspace_features SET enabled=false WHERE name='reports_v1';
