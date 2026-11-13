-- Trials, upgrades and downgrades (phase 16, step C10b; docs/SECURITY_STEP21.md). Additive.
-- A workspace's plan can now change: a 14-day Pro trial taken once, an upgrade that applies at
-- once (its difference prorated on the next invoice), and a downgrade that waits for the end of
-- the period already paid for. Every change is written to an append-only ledger, which the invoice
-- reads: like seats, a plan change is never counted, only read back from what happened.

ALTER TABLE workspace_plans ADD COLUMN trial_plan text CHECK(trial_plan IN ('pro','enterprise'));
ALTER TABLE workspace_plans ADD COLUMN trial_ends_at timestamptz;
-- A trial is offered once per workspace, whether it ran its course or not.
ALTER TABLE workspace_plans ADD COLUMN trial_used boolean NOT NULL DEFAULT false;
-- A scheduled downgrade: the plan it becomes, and when (the end of the period paid for).
ALTER TABLE workspace_plans ADD COLUMN pending_plan text CHECK(pending_plan IN ('starter','pro','enterprise'));
ALTER TABLE workspace_plans ADD COLUMN pending_from timestamptz;
ALTER TABLE workspace_plans ADD CONSTRAINT workspace_plans_trial CHECK((trial_plan IS NULL) = (trial_ends_at IS NULL));
ALTER TABLE workspace_plans ADD CONSTRAINT workspace_plans_pending CHECK((pending_plan IS NULL) = (pending_from IS NULL));
-- The trial's plan and the scheduled change are audited as the plan itself is.
CREATE TRIGGER audit_lifecycle AFTER UPDATE OF trial_ends_at, pending_plan ON workspace_plans
  FOR EACH ROW EXECUTE FUNCTION audit_row('plan','workspace','workspace_id','plan');

-- What happened to the plan, in order: the invoice prorates an upgrade from this, and the page
-- shows it. Written by the server inside the change's own transaction.
CREATE TABLE plan_changes (
 workspace_id text NOT NULL REFERENCES workspace(id),
 seq bigint GENERATED ALWAYS AS IDENTITY,
 kind text NOT NULL CHECK(kind IN ('trial_started','trial_ended','upgraded','downgrade_scheduled','downgrade_cancelled','downgraded')),
 from_plan text NOT NULL CHECK(from_plan IN ('starter','pro','enterprise')),
 to_plan text NOT NULL CHECK(to_plan IN ('starter','pro','enterprise')),
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- When it takes effect: now for a trial or an upgrade, the period's end for a downgrade.
 effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id text, actor_name text,
 PRIMARY KEY(workspace_id,seq));
CREATE INDEX plan_changes_at ON plan_changes(workspace_id,at);
ALTER TABLE plan_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON plan_changes USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE FUNCTION plan_changes_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'plan_changes is append-only'; END $$;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON plan_changes FOR EACH ROW EXECUTE FUNCTION plan_changes_append_only();

-- An invoice can now carry the difference an upgrade owes for the rest of the period it happened in.
ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_kind_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_kind_check CHECK(kind IN ('seats','proration','usage','tax','plan_change'));
