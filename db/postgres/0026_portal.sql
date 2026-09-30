-- Customer ticket portal (phase 05, step C). A verified customer signs in with the workspace's
-- signed identity token or a one-time hand-over from an open messenger session, and sees their
-- own tickets and conversations. Additive.
CREATE TABLE portal_sessions (
 workspace_id text NOT NULL, id text NOT NULL, brand_id text NOT NULL, identity_id text NOT NULL,
 secret_hash text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id),
 FOREIGN KEY(workspace_id,identity_id) REFERENCES identities(workspace_id,id));
-- One-time codes, valid 60 seconds, from a verified messenger session.
CREATE TABLE portal_handoffs (
 workspace_id text NOT NULL, code_hash text NOT NULL, brand_id text NOT NULL, identity_id text NOT NULL,
 expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,code_hash),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id),
 FOREIGN KEY(workspace_id,identity_id) REFERENCES identities(workspace_id,id));
-- Visibility: 'individual' (the customer's own requests) or 'company' (all from their company;
-- acts as 'individual' until phase 01 provides companies).
CREATE TABLE portal_settings (
 workspace_id text PRIMARY KEY, visibility text NOT NULL DEFAULT 'individual' CHECK(visibility IN ('individual','company')),
 updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE ticket_types ADD COLUMN portal_visible boolean NOT NULL DEFAULT true;
ALTER TABLE ticket_types ADD COLUMN portal_visibility text CHECK(portal_visibility IN ('individual','company'));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['portal_sessions','portal_handoffs','portal_settings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
-- Custom domains route to a workspace and brand before any workspace is known. The table keeps
-- the tenant policy like every other; a second, read-only policy lets the routing context
-- (relay.workspace_id='_routing', set only by the portal's host lookup) read host, workspace
-- and brand, which is all this table holds.
-- TODO(phase 17): certificates and DNS verification for these hosts.
CREATE TABLE portal_domains (
 host text PRIMARY KEY CHECK(host ~ '^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$'),
 workspace_id text NOT NULL, brand_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));
CREATE INDEX portal_domains_by_workspace ON portal_domains(workspace_id);
ALTER TABLE portal_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON portal_domains USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE POLICY routing ON portal_domains FOR SELECT USING(current_setting('relay.workspace_id',true)='_routing');
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'portal_v1',false FROM workspace ON CONFLICT DO NOTHING;
