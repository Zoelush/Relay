-- Link safety and risky merges (phase 16, step C7a; docs/SECURITY_STEP11.md). Additive.
-- A workspace's trusted and blocked link domains; what the reputation lookup found for the links in
-- a customer's part (deleted with its conversation); and two merge switches, off by default.

CREATE TABLE link_policies (
 workspace_id text NOT NULL REFERENCES workspace(id),
 domain text NOT NULL CHECK(domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND length(domain) <= 253),
 kind text NOT NULL CHECK(kind IN ('trusted','blocked')),
 created_by text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,domain));
ALTER TABLE link_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON link_policies USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF kind ON link_policies FOR EACH ROW EXECUTE FUNCTION audit_row('link_policy','link_policy','domain','domain');

CREATE TABLE part_links (
 workspace_id text NOT NULL, part_id text NOT NULL, conversation_id text NOT NULL,
 url text NOT NULL CHECK(length(url) <= 2000),
 threat text, checked_at timestamptz,
 PRIMARY KEY(workspace_id,part_id,url),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,part_id) REFERENCES conversation_parts(workspace_id,id));
CREATE INDEX part_links_conversation ON part_links(workspace_id,conversation_id);
ALTER TABLE part_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON part_links USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- Merging conversations of different people, and leads into the one user with their email.
ALTER TABLE security_settings ADD COLUMN merge_across_people boolean NOT NULL DEFAULT false;
ALTER TABLE security_settings ADD COLUMN merge_leads_by_email boolean NOT NULL DEFAULT false;
