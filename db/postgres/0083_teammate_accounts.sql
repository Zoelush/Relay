-- Teammate accounts and sessions (phase 16, step C3a; docs/SECURITY_STEP3.md). Additive.
-- Relay's own sign-in, beside the hosting platform's: an email and password per teammate (scrypt,
-- kept only as a hash), sessions kept on the server (each revocable, held to the workspace's idle
-- and absolute limits), and invitations. Everything is per workspace: a host serves one workspace.

-- A teammate's password sign-in. Failed attempts lock it for a while.
CREATE TABLE teammate_credentials (
 workspace_id text NOT NULL REFERENCES workspace(id), teammate_id text NOT NULL,
 email text NOT NULL CHECK(email = lower(email) AND length(email) BETWEEN 3 AND 320),
 password_hash text NOT NULL,
 password_changed_at timestamptz NOT NULL DEFAULT now(),
 failed_count int NOT NULL DEFAULT 0, locked_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,teammate_id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id));
CREATE UNIQUE INDEX teammate_credentials_email ON teammate_credentials(workspace_id,email);

-- A signed-in browser: its token kept only as a hash; where and what it signed in from.
CREATE TABLE teammate_sessions (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, teammate_id text NOT NULL,
 token_hash text NOT NULL, method text NOT NULL CHECK(method IN ('password','invitation')),
 ip text, user_agent text,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz, revoked_reason text,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id));
CREATE UNIQUE INDEX teammate_sessions_token ON teammate_sessions(workspace_id,token_hash);
CREATE INDEX teammate_sessions_live ON teammate_sessions(workspace_id,teammate_id) WHERE revoked_at IS NULL;

-- An invitation: single use, for a week, to a role. Its link is shown once and emailed. With a
-- teammate, it's a password reset for them instead (a manager sends it; it makes no new teammate).
CREATE TABLE teammate_invitations (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 email text NOT NULL CHECK(email = lower(email)), name text NOT NULL DEFAULT '', role_id text NOT NULL,
 teammate_id text,
 token_hash text NOT NULL, invited_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 accepted_at timestamptz, accepted_teammate_id text, revoked_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,role_id) REFERENCES roles(workspace_id,id));
CREATE UNIQUE INDEX teammate_invitations_token ON teammate_invitations(workspace_id,token_hash);
CREATE UNIQUE INDEX teammate_invitations_open ON teammate_invitations(workspace_id,email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- How long a session lasts: signed out after so long without use, and after so long in all.
CREATE TABLE security_settings (
 workspace_id text PRIMARY KEY REFERENCES workspace(id),
 idle_minutes int NOT NULL DEFAULT 5760 CHECK(idle_minutes BETWEEN 15 AND 43200),
 absolute_hours int NOT NULL DEFAULT 720 CHECK(absolute_hours BETWEEN 1 AND 2160),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now());

-- Invitation emails go through the alert path; the link is sealed until it's sent, then cleared.
ALTER TABLE email_alerts DROP CONSTRAINT IF EXISTS email_alerts_kind_check;
ALTER TABLE email_alerts ADD CONSTRAINT email_alerts_kind_check CHECK(kind IN ('incident','webhook_disabled','invitation'));
ALTER TABLE email_alerts ADD COLUMN invitation_id text;
ALTER TABLE email_alerts ADD COLUMN link_sealed text;
ALTER TABLE email_alerts DROP CONSTRAINT email_alerts_kind_fields;
ALTER TABLE email_alerts ADD CONSTRAINT email_alerts_kind_fields CHECK((kind='incident') = (incident_id IS NOT NULL) AND (kind='webhook_disabled') = (webhook_subscription_id IS NOT NULL) AND (kind='invitation') = (invitation_id IS NOT NULL));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['teammate_credentials','teammate_sessions','teammate_invitations','security_settings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

-- In the audit log (C1): passwords set or changed (as "a secret was replaced"), invitations, and the
-- session limits. Sign-ins, sign-outs and accepted invitations are recorded by the code that makes them.
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF email,password_hash ON teammate_credentials FOR EACH ROW EXECUTE FUNCTION audit_row('account','teammate','teammate_id','email');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OF revoked_at ON teammate_invitations FOR EACH ROW EXECUTE FUNCTION audit_row('invitation','invitation','id','email');
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON security_settings FOR EACH ROW EXECUTE FUNCTION audit_row('session_settings','workspace','workspace_id','');
