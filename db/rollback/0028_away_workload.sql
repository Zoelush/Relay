-- Rollback for 0028_away_workload: additive, so nothing is dropped. The previous version ignores
-- the new columns: no pacing after a return, no returning conversations on away, and team
-- inbox views remain ordinary shared views.
SELECT 1;
