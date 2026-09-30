-- Tickets (phase 05, step A1): workspace-defined ticket types with their own states, allowed
-- transitions and typed fields. A ticket is a conversation with a ticket record attached, so
-- the timeline, notes, assignment, views and realtime apply unchanged. Additive.
CREATE TABLE ticket_types (
 workspace_id text NOT NULL, id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 icon text NOT NULL DEFAULT 'ticket' CHECK(length(icon) BETWEEN 1 AND 32),
 category text NOT NULL CHECK(category IN ('customer','back_office','tracker')),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=500),
 archived boolean NOT NULL DEFAULT false, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,name));
CREATE TABLE ticket_states (
 workspace_id text NOT NULL, id text NOT NULL, type_id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
 customer_label text NOT NULL CHECK(length(customer_label) BETWEEN 1 AND 60),
 kind text NOT NULL CHECK(kind IN ('submitted','in_progress','waiting_on_customer','resolved')),
 position integer NOT NULL, archived boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,type_id,id),
 FOREIGN KEY(workspace_id,type_id) REFERENCES ticket_types(workspace_id,id));
CREATE TABLE ticket_transitions (
 workspace_id text NOT NULL, type_id text NOT NULL, from_state text NOT NULL, to_state text NOT NULL,
 PRIMARY KEY(workspace_id,type_id,from_state,to_state), CHECK(from_state<>to_state),
 FOREIGN KEY(workspace_id,type_id,from_state) REFERENCES ticket_states(workspace_id,type_id,id),
 FOREIGN KEY(workspace_id,type_id,to_state) REFERENCES ticket_states(workspace_id,type_id,id));
-- A type's fields are conversation attribute definitions; values live in
-- conversation_attribute_values like any other conversation attribute.
CREATE TABLE ticket_type_attributes (
 workspace_id text NOT NULL, type_id text NOT NULL, attribute_id text NOT NULL,
 required_to_close boolean NOT NULL DEFAULT false, position integer NOT NULL,
 PRIMARY KEY(workspace_id,type_id,attribute_id),
 FOREIGN KEY(workspace_id,type_id) REFERENCES ticket_types(workspace_id,id),
 FOREIGN KEY(workspace_id,attribute_id) REFERENCES attribute_definitions(workspace_id,id));
CREATE TABLE tickets (
 workspace_id text NOT NULL, conversation_id text NOT NULL, number bigint NOT NULL,
 type_id text NOT NULL, state_id text NOT NULL, version bigint NOT NULL DEFAULT 1,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,conversation_id), UNIQUE(workspace_id,number),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,type_id,state_id) REFERENCES ticket_states(workspace_id,type_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES teammates(workspace_id,id));
CREATE INDEX tickets_by_state ON tickets(workspace_id,type_id,state_id);
CREATE TABLE ticket_counters (workspace_id text PRIMARY KEY, next bigint NOT NULL DEFAULT 1);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ticket_types','ticket_states','ticket_transitions','ticket_type_attributes','tickets','ticket_counters'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
-- `tickets.manage` (define ticket types) goes to roles that already manage the workspace.
INSERT INTO role_capabilities(workspace_id,role_id,capability)
 SELECT workspace_id,role_id,'tickets.manage' FROM role_capabilities WHERE capability='workspace.manage' ON CONFLICT DO NOTHING;
-- Off for every existing workspace.
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'tickets_v1',false FROM workspace ON CONFLICT DO NOTHING;
