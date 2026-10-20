-- Rollback for 0075_reporting_presence: nothing to undo for reporting's flag (0074's rollback turns
-- it off). The trigger only adds rows, and the history stays.
SELECT 1;
