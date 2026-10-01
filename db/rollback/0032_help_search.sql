-- Rollback for 0032_help_search: additive, so nothing is dropped. The previous version neither
-- writes nor reads the search index, query log or feedback; turning `help_center_v1` off takes
-- the public search and feedback offline. Rows already logged keep their 180-day retention.
SELECT 1;
