-- Canonical conversation counts for anonymous identities and verified contacts.
-- Existing per-original read positions and counters remain for rollback.
CREATE TABLE customer_unread_threads (
 workspace_id text NOT NULL,
 audience_type text NOT NULL CHECK (audience_type IN ('identity','contact')),
 identity_id text,
 contact_id text,
 audience_id text GENERATED ALWAYS AS (COALESCE(identity_id,contact_id)) STORED,
 conversation_id text NOT NULL,
 brand_id text NOT NULL,
 PRIMARY KEY (workspace_id,audience_type,audience_id,conversation_id),
 CHECK ((audience_type='identity' AND identity_id IS NOT NULL AND contact_id IS NULL)
     OR (audience_type='contact' AND contact_id IS NOT NULL AND identity_id IS NULL)),
 FOREIGN KEY (workspace_id,identity_id) REFERENCES identities(workspace_id,id),
 FOREIGN KEY (workspace_id,contact_id) REFERENCES contacts(workspace_id,id),
 FOREIGN KEY (workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY (workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
CREATE INDEX customer_unread_threads_conversation ON customer_unread_threads(workspace_id,conversation_id);
CREATE TABLE customer_unread_totals (
 workspace_id text NOT NULL,
 audience_type text NOT NULL CHECK (audience_type IN ('identity','contact')),
 identity_id text,
 contact_id text,
 audience_id text GENERATED ALWAYS AS (COALESCE(identity_id,contact_id)) STORED,
 brand_id text NOT NULL,
 unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count>=0),
 version bigint NOT NULL DEFAULT 0,
 PRIMARY KEY (workspace_id,audience_type,audience_id,brand_id),
 CHECK ((audience_type='identity' AND identity_id IS NOT NULL AND contact_id IS NULL)
     OR (audience_type='contact' AND contact_id IS NOT NULL AND identity_id IS NULL)),
 FOREIGN KEY (workspace_id,identity_id) REFERENCES identities(workspace_id,id),
 FOREIGN KEY (workspace_id,contact_id) REFERENCES contacts(workspace_id,id),
 FOREIGN KEY (workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
CREATE INDEX customer_reads_conversation ON customer_reads(workspace_id,conversation_id,identity_id);
CREATE INDEX contacts_redirect ON contacts(workspace_id,merged_into_contact_id) WHERE merged_into_contact_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['customer_unread_threads','customer_unread_totals'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
