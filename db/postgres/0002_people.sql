CREATE TABLE brands (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, name text NOT NULL,
 settings jsonb NOT NULL DEFAULT '{}', identity_enforced boolean NOT NULL DEFAULT true,
 legacy_hmac_enabled boolean NOT NULL DEFAULT false, PRIMARY KEY(workspace_id,id)
);
CREATE TABLE workspace_features (
 workspace_id text NOT NULL REFERENCES workspace(id), name text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, PRIMARY KEY(workspace_id,name)
);
CREATE TABLE roles (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, name text NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,name)
);
CREATE TABLE role_capabilities (
 workspace_id text NOT NULL, role_id text NOT NULL, capability text NOT NULL,
 PRIMARY KEY(workspace_id,role_id,capability), FOREIGN KEY(workspace_id,role_id) REFERENCES roles(workspace_id,id)
);
CREATE TABLE teammates (
 workspace_id text NOT NULL, id text NOT NULL, principal_id text NOT NULL, name text NOT NULL,
 role_id text NOT NULL, presence text NOT NULL DEFAULT 'active' CHECK(presence IN ('active','away','away_reassigning')),
 seat text NOT NULL DEFAULT 'full' CHECK(seat IN ('full','limited')),
 schedule jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,principal_id),
 FOREIGN KEY(workspace_id,role_id) REFERENCES roles(workspace_id,id)
);
CREATE TABLE teams (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, name text NOT NULL, PRIMARY KEY(workspace_id,id)
);
CREATE TABLE teammate_teams (
 workspace_id text NOT NULL, teammate_id text NOT NULL, team_id text NOT NULL, PRIMARY KEY(workspace_id,teammate_id,team_id),
 FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id), FOREIGN KEY(workspace_id,team_id) REFERENCES teams(workspace_id,id)
);
CREATE TABLE contacts (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 role text NOT NULL CHECK(role IN ('visitor','lead','user')), name text NOT NULL DEFAULT '',
 external_id text, profile jsonb NOT NULL DEFAULT '{}', merged_into_contact_id text,
 first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 signed_up_at timestamptz, origin_timezone text, global_unsubscribe boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,external_id),
 CHECK(merged_into_contact_id IS NULL OR merged_into_contact_id<>id),
 FOREIGN KEY(workspace_id,merged_into_contact_id) REFERENCES contacts(workspace_id,id)
);
CREATE TABLE contact_emails (
 workspace_id text NOT NULL, contact_id text NOT NULL, email text NOT NULL, verified boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,contact_id,email), FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id)
);
CREATE TABLE contact_phones (
 workspace_id text NOT NULL, contact_id text NOT NULL, phone text NOT NULL, verified boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,contact_id,phone), FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id)
);
CREATE TABLE identities (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('anonymous','user')), identifier_hash text NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,kind,identifier_hash)
);
CREATE TABLE identity_contact_mappings (
 workspace_id text NOT NULL, identity_id text NOT NULL, contact_id text NOT NULL, version bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,identity_id), FOREIGN KEY(workspace_id,identity_id) REFERENCES identities(workspace_id,id),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id)
);
CREATE TABLE contact_merges (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, loser_id text NOT NULL, survivor_id text NOT NULL,
 changes jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), reversed_at timestamptz,
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,loser_id) REFERENCES contacts(workspace_id,id),
 FOREIGN KEY(workspace_id,survivor_id) REFERENCES contacts(workspace_id,id)
);
CREATE TABLE identity_keys (
 workspace_id text NOT NULL REFERENCES workspace(id), kid text NOT NULL, slot smallint NOT NULL CHECK(slot IN (1,2)),
 wrapped_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,kid), UNIQUE(workspace_id,slot)
);
CREATE TABLE messenger_sessions (
 workspace_id text NOT NULL, id text NOT NULL, brand_id text NOT NULL, identity_id text NOT NULL,
 secret_hash text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 page_url text NOT NULL, locale text NOT NULL, version bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id),
 FOREIGN KEY(workspace_id,identity_id) REFERENCES identities(workspace_id,id)
);
CREATE TABLE business_calendars (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, version integer NOT NULL,
 timezone text NOT NULL, schedule jsonb NOT NULL, PRIMARY KEY(workspace_id,id,version)
);
CREATE TABLE tags (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, name text NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,name)
);
CREATE TABLE attribute_definitions (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, name text NOT NULL,
 owner_type text NOT NULL CHECK(owner_type IN ('contact','company','conversation','object')),
 value_type text NOT NULL CHECK(value_type IN ('string','integer','float','boolean','date','options')),
 options jsonb, archived_at timestamptz, PRIMARY KEY(workspace_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['brands','workspace_features','roles','role_capabilities','teammates','teams','teammate_teams',
 'contacts','contact_emails','contact_phones','identities','identity_contact_mappings','contact_merges','identity_keys',
 'messenger_sessions','business_calendars','tags','attribute_definitions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id = current_setting(''relay.workspace_id'',true)) WITH CHECK (workspace_id = current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
