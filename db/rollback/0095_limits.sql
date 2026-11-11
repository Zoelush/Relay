-- Rollback for 0095_limits: every limit and the spend cap removed, so nothing is paused, and
-- messages held by a limit are released (due now: the earlier code's sweep sends them).
-- The tables and their audit records stay.
DELETE FROM usage_limits;
UPDATE usage_settings SET spend_cap_cents=NULL WHERE spend_cap_cents IS NOT NULL;
UPDATE channel_deliveries SET not_before=now(),limit_held=false WHERE limit_held;
