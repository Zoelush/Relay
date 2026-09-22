CREATE TABLE customer_reads (
 workspace_id text NOT NULL, identity_id text NOT NULL, conversation_id text NOT NULL,
 latest_reply_seq bigint NOT NULL DEFAULT 0, read_seq bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,identity_id,conversation_id),
 FOREIGN KEY(workspace_id,identity_id) REFERENCES identities(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE TABLE customer_counters (
 workspace_id text NOT NULL, identity_id text NOT NULL, brand_id text NOT NULL,
 unread_count integer NOT NULL DEFAULT 0 CHECK(unread_count>=0), version bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,identity_id,brand_id), FOREIGN KEY(workspace_id,identity_id) REFERENCES identities(workspace_id,id),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['customer_reads','customer_counters'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
