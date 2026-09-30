-- Tickets step A2: back-office and tracker tickets are internal conversations (no customer),
-- linked to customer conversations; trackers broadcast one update to every linked conversation.
-- Additive.
ALTER TABLE conversations ADD COLUMN visibility text NOT NULL DEFAULT 'customer' CHECK(visibility IN ('customer','internal'));
CREATE TABLE ticket_links (
 workspace_id text NOT NULL, ticket_id text NOT NULL, conversation_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('back_office','tracker')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,ticket_id,conversation_id), CHECK(ticket_id<>conversation_id),
 FOREIGN KEY(workspace_id,ticket_id) REFERENCES tickets(workspace_id,conversation_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES teammates(workspace_id,id));
CREATE INDEX ticket_links_by_conversation ON ticket_links(workspace_id,conversation_id);
CREATE TABLE ticket_broadcasts (
 workspace_id text NOT NULL, id text NOT NULL, tracker_id text NOT NULL, teammate_id text NOT NULL,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 5000), close_after boolean NOT NULL DEFAULT false,
 total integer NOT NULL CHECK(total BETWEEN 0 AND 5000),
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','running','done')),
 job_id text, created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz, completed_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,tracker_id) REFERENCES tickets(workspace_id,conversation_id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id));
CREATE TABLE broadcast_items (
 workspace_id text NOT NULL, broadcast_id text NOT NULL, conversation_id text NOT NULL, position integer NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','skipped','failed')),
 closed boolean NOT NULL DEFAULT false, error text,
 PRIMARY KEY(workspace_id,broadcast_id,conversation_id),
 FOREIGN KEY(workspace_id,broadcast_id) REFERENCES ticket_broadcasts(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE INDEX broadcast_items_next ON broadcast_items(workspace_id,broadcast_id,state,position);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ticket_links','ticket_broadcasts','broadcast_items'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
