-- Vendor support access (phase 16, step C7b; docs/SECURITY_STEP12.md). Additive.
-- A workspace's grants of read-only access to Relay's support staff (time-limited, revocable,
-- kept as history); staff sign-ins in progress (OIDC, bound to the browser); and staff sessions.

CREATE TABLE support_grants (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 granted_by text NOT NULL, granted_by_name text NOT NULL DEFAULT '',
 granted_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz, revoked_by text, revoked_by_name text,
 PRIMARY KEY(workspace_id,id),
 CHECK(expires_at > granted_at AND expires_at <= granted_at + interval '14 days 1 minute'));
-- At most one grant open at a time (a new one ends the old one first).
CREATE UNIQUE INDEX support_grants_open ON support_grants(workspace_id) WHERE revoked_at IS NULL;
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON support_grants USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE TRIGGER audit AFTER INSERT OR UPDATE OF revoked_at ON support_grants FOR EACH ROW EXECUTE FUNCTION audit_row('support_grant','support_grant','id','');

CREATE TABLE support_logins (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 token_hash text NOT NULL, state text NOT NULL, nonce text NOT NULL, verifier text NOT NULL,
 expires_at timestamptz NOT NULL, used_at timestamptz,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,token_hash));
ALTER TABLE support_logins ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_logins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON support_logins USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

CREATE TABLE support_sessions (
 workspace_id text NOT NULL, id text NOT NULL, grant_id text NOT NULL,
 token_hash text NOT NULL, email text NOT NULL, subject text NOT NULL,
 ip text, user_agent text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, revoked_reason text,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,token_hash),
 FOREIGN KEY(workspace_id,grant_id) REFERENCES support_grants(workspace_id,id));
ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON support_sessions USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
