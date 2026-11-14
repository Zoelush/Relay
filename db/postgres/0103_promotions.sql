-- Promoting a change from a test workspace to production (docs/TEST_WORKSPACE_PLAN.md, T2). Additive.
--
-- Two records make it possible to be honest about what a promotion means. Both live in the
-- production workspace, so a promotion writes the change and moves the mark in one transaction.
--
--  * `test_baselines` holds, for each promotable object, the two version numbers the pair was last
--    in step at: production's and the test workspace's. It is written when the pair is made and
--    moved forward by each promotion. Without it neither side could tell "changed here" from
--    "changed there" — the copy gives both the same numbers to start with, and the two counters
--    then run on independently.
--  * `promotions` records what was promoted into this workspace: by whom, from which version to
--    which, and what it held before, for the kinds that keep no versions of their own. It is
--    append-only, like the other ledgers.

CREATE TABLE test_baselines (
 -- The production workspace, and the test workspace it is paired with.
 workspace_id text NOT NULL REFERENCES workspace(id),
 test_workspace text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('workflow','zoe_guidance','messenger','help_center')),
 object_id text NOT NULL,
 -- What production's object was at, and what the test workspace's copy was at, when they were
 -- last in step: the moment the pair was made, or the last promotion.
 version bigint NOT NULL,
 from_version bigint NOT NULL,
 taken_at timestamptz NOT NULL DEFAULT now(),
 synced_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,test_workspace,kind,object_id));
ALTER TABLE test_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_baselines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON test_baselines USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

CREATE TABLE promotions (
 workspace_id text NOT NULL REFERENCES workspace(id),
 id text NOT NULL,
 seq bigint GENERATED ALWAYS AS IDENTITY,
 from_workspace text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('workflow','zoe_guidance','messenger','help_center')),
 object_id text NOT NULL,
 object_name text NOT NULL DEFAULT '',
 -- The version promoted, in the test workspace, and the version it was published as here.
 from_version bigint,
 to_version bigint,
 -- What production held before, for a kind that keeps no versions of its own to go back to.
 previous jsonb,
 at timestamptz NOT NULL DEFAULT now(),
 actor_id text, actor_name text,
 PRIMARY KEY(workspace_id,id));
CREATE INDEX promotions_at ON promotions(workspace_id,at DESC);
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON promotions USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE FUNCTION promotions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'promotions is append-only'; END $$;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON promotions FOR EACH ROW EXECUTE FUNCTION promotions_append_only();
