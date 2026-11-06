-- Plans (phase 16, step C8a; docs/SECURITY_STEP14.md). Additive.
-- Each workspace's plan tier. What each tier includes is the plan policy (lib/plans.ts), read only
-- by server/plans.ts. Every workspace starts on Enterprise, so nothing it uses switches off;
-- choosing a plan comes with billing (C10).

CREATE TABLE workspace_plans (
 workspace_id text PRIMARY KEY REFERENCES workspace(id),
 plan text NOT NULL DEFAULT 'enterprise' CHECK(plan IN ('starter','pro','enterprise')),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE workspace_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON workspace_plans USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE TRIGGER audit AFTER INSERT OR UPDATE OF plan ON workspace_plans FOR EACH ROW EXECUTE FUNCTION audit_row('plan','workspace','workspace_id','plan');

INSERT INTO workspace_plans(workspace_id) SELECT id FROM workspace ON CONFLICT DO NOTHING;
