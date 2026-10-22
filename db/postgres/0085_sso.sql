-- Single sign-on (phase 16, step C4a; docs/SECURITY_STEP5.md). Additive.
-- One connection per workspace (OIDC now, SAML in C4b), the email domains it may sign in, its
-- group-to-role mappings, the identities it has signed in, and short-lived logins between the
-- redirect to the identity provider and its return. Enforced SSO leaves owners their password.

-- The connection. The client secret is sealed with the connector key and never returned.
CREATE TABLE sso_connections (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 protocol text NOT NULL DEFAULT 'oidc' CHECK(protocol IN ('oidc')),
 name text NOT NULL DEFAULT '' CHECK(length(name) <= 80),
 issuer text NOT NULL, client_id text NOT NULL, client_secret_sealed text,
 authorization_endpoint text NOT NULL, token_endpoint text NOT NULL, jwks_uri text NOT NULL,
 groups_claim text NOT NULL DEFAULT 'groups',
 enabled boolean NOT NULL DEFAULT false, enforced boolean NOT NULL DEFAULT false,
 last_success_at timestamptz, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 CHECK(NOT enforced OR enabled));
CREATE UNIQUE INDEX sso_connections_one ON sso_connections(workspace_id);

-- Email domains, verified by a DNS TXT record. A domain is verified by one workspace at a time.
CREATE TABLE sso_domains (
 workspace_id text NOT NULL REFERENCES workspace(id),
 domain text NOT NULL CHECK(domain = lower(domain) AND domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
 token text NOT NULL, verified_at timestamptz, checked_at timestamptz, error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,domain));
CREATE UNIQUE INDEX sso_domains_verified ON sso_domains(domain) WHERE verified_at IS NOT NULL;

-- Groups to roles, in order: the first group a person is in decides. Never the owner role.
CREATE TABLE sso_role_mappings (
 workspace_id text NOT NULL REFERENCES workspace(id), connection_id text NOT NULL,
 position int NOT NULL CHECK(position >= 0), group_name text NOT NULL CHECK(length(group_name) BETWEEN 1 AND 200),
 role_id text NOT NULL CHECK(role_id <> 'owner'),
 PRIMARY KEY(workspace_id,connection_id,position),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES sso_connections(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,role_id) REFERENCES roles(workspace_id,id));

-- Who has signed in through the connection: by the provider's subject, never by email.
CREATE TABLE sso_identities (
 workspace_id text NOT NULL REFERENCES workspace(id), connection_id text NOT NULL, subject text NOT NULL,
 teammate_id text NOT NULL, email text NOT NULL, groups text[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), last_sign_in_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connection_id,subject),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES sso_connections(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id));
CREATE UNIQUE INDEX sso_identities_teammate ON sso_identities(workspace_id,connection_id,teammate_id);

-- Between the redirect to the provider and its return: state, nonce and PKCE verifier. Ten
-- minutes, used once. Its token (the host's cookie) is kept only as a hash.
CREATE TABLE sso_logins (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, connection_id text NOT NULL,
 token_hash text NOT NULL, state text NOT NULL, nonce text NOT NULL, verifier text NOT NULL,
 next text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES sso_connections(workspace_id,id) ON DELETE CASCADE);
CREATE UNIQUE INDEX sso_logins_token ON sso_logins(workspace_id,token_hash);

-- Sessions started by SSO.
ALTER TABLE teammate_sessions DROP CONSTRAINT teammate_sessions_method_check;
ALTER TABLE teammate_sessions ADD CONSTRAINT teammate_sessions_method_check CHECK(method IN ('password','invitation','sso'));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sso_connections','sso_domains','sso_role_mappings','sso_identities','sso_logins'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

-- In the audit log (C1): the connection (its secret only as replaced), domains added, verified or
-- removed, and the role mappings. Sign-ins, refusals and break-glass are recorded by the code.
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF name,issuer,client_id,client_secret_sealed,groups_claim,enabled,enforced ON sso_connections FOR EACH ROW EXECUTE FUNCTION audit_row('sso','sso_connection','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF verified_at ON sso_domains FOR EACH ROW EXECUTE FUNCTION audit_row('sso_domain','sso_domain','domain','domain');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON sso_role_mappings FOR EACH ROW EXECUTE FUNCTION audit_row('sso_role','sso_connection','connection_id','group_name');
