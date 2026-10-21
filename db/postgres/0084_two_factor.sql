-- Two-factor sign-in and IP allowlists (phase 16, step C3b; docs/SECURITY_STEP4.md). Additive.
-- TOTP two-factor for password sign-in (the key sealed, recovery codes kept only as hashes), a
-- short-lived challenge between the password and the code, a switch to require two-factor, and
-- two IP allowlists: one for the app, one for the REST API.

-- A teammate's authenticator: pending until the first code confirms it. Codes are used once.
CREATE TABLE teammate_two_factor (
 workspace_id text NOT NULL REFERENCES workspace(id), teammate_id text NOT NULL,
 secret_sealed text NOT NULL,
 enabled_at timestamptz, last_step bigint,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,teammate_id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id));

-- Recovery codes: ten at a time, each used once, kept only as hashes.
CREATE TABLE teammate_recovery_codes (
 workspace_id text NOT NULL REFERENCES workspace(id), teammate_id text NOT NULL,
 code_hash text NOT NULL, used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,teammate_id,code_hash),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id));

-- Between a right password and a session: verify a code, or set two-factor up first. Ten
-- minutes, five wrong codes, used once. Its token is kept only as a hash.
CREATE TABLE teammate_challenges (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, teammate_id text NOT NULL,
 token_hash text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('verify','setup')),
 method text NOT NULL CHECK(method IN ('password','invitation')),
 attempts int NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id));
CREATE UNIQUE INDEX teammate_challenges_token ON teammate_challenges(workspace_id,token_hash);

-- How a session's second factor was given, if it was.
ALTER TABLE teammate_sessions ADD COLUMN two_factor text CHECK(two_factor IN ('totp','recovery'));

-- The switch, and the two allowlists (empty: anywhere).
ALTER TABLE security_settings ADD COLUMN require_two_factor boolean NOT NULL DEFAULT false;
ALTER TABLE security_settings ADD COLUMN app_allowlist cidr[] NOT NULL DEFAULT '{}' CHECK(cardinality(app_allowlist) <= 100);
ALTER TABLE security_settings ADD COLUMN api_allowlist cidr[] NOT NULL DEFAULT '{}' CHECK(cardinality(api_allowlist) <= 100);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['teammate_two_factor','teammate_recovery_codes','teammate_challenges'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
-- In the audit log: the switch and the allowlists through security_settings' trigger (0083), and
-- two-factor turned on, off or reset, recovery codes replaced or used, and wrong codes, by the code.
