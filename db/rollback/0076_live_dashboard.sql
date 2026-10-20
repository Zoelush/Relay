-- Rollback for 0076_live_dashboard: the two indexes go (the dashboard reads nothing else of its own).
DROP INDEX IF EXISTS conversations_live_waiting;
DROP INDEX IF EXISTS conversations_live;
