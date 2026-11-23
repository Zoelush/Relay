-- The paired test workspace, T3b (docs/TEST_WORKSPACE_STEP6.md): review by Relay's operators, and
-- the app directory. Additive.
--
-- An app gains its install address: its own page that starts the consent flow, where the
-- directory sends people who press Install. Versions keep it as published.
ALTER TABLE oauth_apps ADD COLUMN install_url text;
ALTER TABLE oauth_app_versions ADD COLUMN install_url text;
-- The card an operator last approved, kept on the developer's own app row: a release compares
-- itself with it in its own transaction, so a version that widens the app's reach can never be
-- released without review, whichever way the release arrives. Written only by an approval.
ALTER TABLE oauth_apps ADD COLUMN listed_card jsonb;

-- The directory lives in a tenant of its own, '__directory__', the way relay_schema_migrations
-- lives in '__schema__': row-level security like every table, and no workspace row, so nothing
-- that walks workspaces ever finds it.
--
-- What an operator is asked to judge, and what they decided.
CREATE TABLE app_submissions (
 workspace_id text NOT NULL CHECK(workspace_id='__directory__'),
 id text NOT NULL,
 app_workspace_id text NOT NULL, app_id text NOT NULL, version int NOT NULL,
 kind text NOT NULL CHECK(kind IN ('listing','version')),
 card jsonb NOT NULL,
 widens text[] NOT NULL DEFAULT '{}',
 submitted_at timestamptz NOT NULL DEFAULT now(), submitted_by_name text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','withdrawn')),
 decided_at timestamptz, decided_by text, reason text,
 PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX app_submissions_open ON app_submissions(workspace_id,app_workspace_id,app_id) WHERE state='pending';
CREATE INDEX app_submissions_app ON app_submissions(workspace_id,app_workspace_id,app_id,submitted_at);
-- What the directory shows. Delisting is recorded on the row, so relisting needs no new review.
CREATE TABLE app_listings (
 workspace_id text NOT NULL CHECK(workspace_id='__directory__'),
 app_workspace_id text NOT NULL, app_id text NOT NULL,
 card jsonb NOT NULL, version int NOT NULL,
 listed_at timestamptz NOT NULL DEFAULT now(),
 delisted_at timestamptz, delisted_by text, delisted_reason text,
 PRIMARY KEY(workspace_id,app_workspace_id,app_id));
-- Apps stopped everywhere, and the reason every workspace that installed one is shown.
CREATE TABLE app_suspensions (
 workspace_id text NOT NULL CHECK(workspace_id='__directory__'),
 app_workspace_id text NOT NULL, app_id text NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 suspended_at timestamptz NOT NULL DEFAULT now(), suspended_by text NOT NULL,
 lifted_at timestamptz, lifted_by text,
 PRIMARY KEY(workspace_id,app_workspace_id,app_id));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['app_submissions','app_listings','app_suspensions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

-- The signed notice an app is sent when it is uninstalled, logged with its other requests.
ALTER TABLE canvas_calls DROP CONSTRAINT canvas_calls_kind_check;
ALTER TABLE canvas_calls ADD CONSTRAINT canvas_calls_kind_check CHECK(kind IN ('initialize','submit','configure','uninstalled'));
