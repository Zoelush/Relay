-- Data-preserving rollback: keep both tables. The previous application version has no bulk
-- routes or job handlers; bulk jobs still queued then fail with JOB_HANDLER_UNAVAILABLE and
-- reach the dead-letter queue, leaving any items they had not reached untouched.
SELECT 1;
