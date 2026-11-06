-- Rollback for 0092_plans: every workspace back on Enterprise, so nothing is gated by plan (the
-- earlier code doesn't read plans). The table and its audit records stay.
UPDATE workspace_plans SET plan='enterprise' WHERE plan<>'enterprise';
