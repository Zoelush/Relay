-- Macros: a saved reply (rich text with variables) plus a bundle of actions. Additive.
CREATE TABLE macros (
 workspace_id text NOT NULL, id text NOT NULL, owner_id text NOT NULL,
 shared boolean NOT NULL DEFAULT false, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 mode text NOT NULL CHECK(mode IN ('reply','note')), body jsonb, actions jsonb NOT NULL DEFAULT '[]',
 version bigint NOT NULL DEFAULT 1, archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES teammates(workspace_id,id)
);
CREATE INDEX macros_visible ON macros(workspace_id,shared,owner_id) WHERE NOT archived;
ALTER TABLE macros ENABLE ROW LEVEL SECURITY;
ALTER TABLE macros FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON macros USING (workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK (workspace_id=current_setting('relay.workspace_id',true));
-- Permissions. `macros.use` (apply macros; create, edit and delete one's own personal macros)
-- goes to the default roles. Shared macros need `macros.create`/`edit`/`delete`, granted only
-- to roles that already hold `macros.manage`, so no role gains anything it could not do before.
INSERT INTO role_capabilities(workspace_id,role_id,capability)
 SELECT workspace_id,id,'macros.use' FROM roles WHERE id IN ('owner','admin','agent') ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(workspace_id,role_id,capability)
 SELECT r.workspace_id,r.role_id,c.capability FROM role_capabilities r
 CROSS JOIN (VALUES ('macros.create'),('macros.edit'),('macros.delete')) AS c(capability)
 WHERE r.capability='macros.manage' ON CONFLICT DO NOTHING;
