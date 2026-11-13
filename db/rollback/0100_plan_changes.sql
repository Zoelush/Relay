-- Rollback for 0100_plan_changes: no plan changes anywhere. Every workspace keeps the plan it has
-- in force right now, so nothing it uses switches off: a running trial's plan becomes its plan,
-- and a scheduled downgrade is dropped. The ledger and the columns stay, unread by earlier code.
UPDATE workspace_plans SET plan=trial_plan WHERE trial_plan IS NOT NULL AND trial_ends_at > now();
UPDATE workspace_plans SET trial_plan=NULL, trial_ends_at=NULL, pending_plan=NULL, pending_from=NULL
  WHERE trial_plan IS NOT NULL OR pending_plan IS NOT NULL;
