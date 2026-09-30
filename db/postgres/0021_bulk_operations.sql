-- Bulk actions with a server-counted selection and a short, conflict-aware undo. Additive.
CREATE TABLE bulk_operations (
 workspace_id text NOT NULL, id text NOT NULL, teammate_id text NOT NULL,
 action jsonb NOT NULL, selection jsonb NOT NULL, total integer NOT NULL CHECK(total BETWEEN 1 AND 5000),
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','running','done','undoing','undone')),
 created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz, completed_at timestamptz,
 undo_until timestamptz, undo_requested_at timestamptz, undone_at timestamptz,
 job_id text, undo_job_id text,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id)
);
-- One row per selected conversation, in selection order. `before`/`after` hold the fields the
-- action changed, so undo can reverse exactly that and detect a later change by someone else.
CREATE TABLE bulk_items (
 workspace_id text NOT NULL, operation_id text NOT NULL, conversation_id text NOT NULL, position integer NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','skipped','failed','cancelled','undone','conflict')),
 before jsonb, after jsonb, error text, undo_error text,
 PRIMARY KEY(workspace_id,operation_id,conversation_id),
 FOREIGN KEY(workspace_id,operation_id) REFERENCES bulk_operations(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE INDEX bulk_items_next ON bulk_items(workspace_id,operation_id,state,position);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['bulk_operations','bulk_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
