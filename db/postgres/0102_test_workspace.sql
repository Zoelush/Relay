-- The paired test workspace (docs/TEST_WORKSPACE_PLAN.md, T1a). Additive.
-- A test workspace is a workspace of its own, owned by a production one: same configuration,
-- made-up customers, and nothing it does can reach a real person. The pair is the only link
-- between them, and it decides who may switch into it; neither reads the other's rows.

-- The pair is written on both rows, because a workspace can only read its own: `test_of` on the
-- test workspace names the production one, and `test_workspace_id` on the production one names
-- the test. Neither side reads the other's row to answer "which pair am I in?".
ALTER TABLE workspace ADD COLUMN test_of text REFERENCES workspace(id);
ALTER TABLE workspace ADD COLUMN test_workspace_id text REFERENCES workspace(id);
-- One test workspace per production workspace, and a test workspace is never the test of a test.
CREATE UNIQUE INDEX workspace_test_of ON workspace(test_of) WHERE test_of IS NOT NULL;
CREATE UNIQUE INDEX workspace_test_workspace ON workspace(test_workspace_id) WHERE test_workspace_id IS NOT NULL;
ALTER TABLE workspace ADD CONSTRAINT workspace_test_not_self CHECK(test_of IS NULL OR test_of <> id);
ALTER TABLE workspace ADD CONSTRAINT workspace_test_one_side CHECK(test_of IS NULL OR test_workspace_id IS NULL);
CREATE TRIGGER audit AFTER UPDATE OF test_of, test_workspace_id ON workspace FOR EACH ROW EXECUTE FUNCTION audit_row('workspace','workspace','id','test_of');

-- What a test workspace would have sent, and didn't: the sink every outbound channel ends in
-- there, so a team can see what their workflow or Zoe would have done to a real person.
CREATE TABLE test_deliveries (
 workspace_id text NOT NULL REFERENCES workspace(id),
 id text NOT NULL,
 channel text NOT NULL,
 address text NOT NULL,
 conversation_id text,
 part_id text,
 body text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id));
CREATE INDEX test_deliveries_at ON test_deliveries(workspace_id,created_at DESC);
ALTER TABLE test_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON test_deliveries USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
