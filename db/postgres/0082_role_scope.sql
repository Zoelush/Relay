-- Roles and the permissions matrix (phase 16, step C2; docs/SECURITY_STEP2.md). Additive.
-- A role's scope: every conversation ('all'), or only those assigned to its teammate or their
-- teams ('assigned', for outsourced teams). A restricted role never has personal data, reports,
-- exports, or anything that manages the workspace: this trigger holds it, whatever the code does.
ALTER TABLE roles ADD COLUMN scope text NOT NULL DEFAULT 'all' CHECK(scope IN ('all','assigned'));

CREATE FUNCTION role_scope_allows(capability text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT capability = ANY(ARRAY['conversations.read','conversations.reply','conversations.note','conversations.manage',
  'conversations.assign','conversations.delete_reply','conversations.delete_note','macros.use'])
$$;
CREATE FUNCTION role_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME = 'role_capabilities' THEN
  IF NOT role_scope_allows(NEW.capability) AND EXISTS(SELECT 1 FROM roles r WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.role_id AND r.scope='assigned') THEN
   RAISE EXCEPTION 'A restricted role can''t have %', NEW.capability USING ERRCODE = 'check_violation';
  END IF;
 ELSIF NEW.scope = 'assigned' AND EXISTS(SELECT 1 FROM role_capabilities c WHERE c.workspace_id=NEW.workspace_id AND c.role_id=NEW.id AND NOT role_scope_allows(c.capability)) THEN
  RAISE EXCEPTION 'A restricted role can''t keep permissions beyond its conversations' USING ERRCODE = 'check_violation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER role_scope_guard BEFORE INSERT OR UPDATE ON role_capabilities FOR EACH ROW EXECUTE FUNCTION role_scope_guard();
CREATE TRIGGER role_scope_guard BEFORE INSERT OR UPDATE OF scope ON roles FOR EACH ROW EXECUTE FUNCTION role_scope_guard();
-- The owner role is never restricted.
ALTER TABLE roles ADD CONSTRAINT owner_sees_all CHECK(id <> 'owner' OR scope = 'all');

-- A new permission, `security.manage` (the audit log, and later sign-in and sessions), for every
-- role that manages the workspace today, so nobody loses the audit log they could see.
INSERT INTO role_capabilities(workspace_id,role_id,capability)
 SELECT workspace_id,role_id,'security.manage' FROM role_capabilities WHERE capability='workspace.manage' ON CONFLICT DO NOTHING;
