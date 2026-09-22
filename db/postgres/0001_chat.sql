-- Additive target schema. The source D1 schema remains intact.
CREATE TABLE IF NOT EXISTS workspace (
  id text PRIMARY KEY, workspace_id text NOT NULL UNIQUE CHECK (workspace_id = id),
  owner_id text NOT NULL, brand text NOT NULL, greeting text NOT NULL,
  color text NOT NULL, availability text NOT NULL,
  timezone text, locale text, settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversations (
  workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
  token_hash text NOT NULL, name text NOT NULL, email text NOT NULL, title text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','snoozed')),
  assigned text NOT NULL DEFAULT '', priority boolean NOT NULL DEFAULT false,
  unread boolean NOT NULL DEFAULT true, sample boolean NOT NULL DEFAULT false,
  tag text NOT NULL DEFAULT 'New conversation', created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL, origin_timezone text,
  PRIMARY KEY (workspace_id,id)
);
CREATE INDEX IF NOT EXISTS conversations_inbox ON conversations(workspace_id,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS messages (
  workspace_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('visitor','agent','note')), body text NOT NULL,
  sender text NOT NULL, created_at timestamptz NOT NULL, origin_timezone text,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS messages_timeline ON messages(workspace_id,conversation_id,created_at,id);
CREATE TABLE IF NOT EXISTS idempotency_receipts (
  workspace_id text NOT NULL REFERENCES workspace(id), scope text NOT NULL, key text NOT NULL,
  digest text NOT NULL, response jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,scope,key)
);
CREATE TABLE IF NOT EXISTS storage_migration_state (
  workspace_id text PRIMARY KEY REFERENCES workspace(id), epoch bigint NOT NULL DEFAULT 0,
  authority text NOT NULL CHECK (authority IN ('d1','frozen','postgres')),
  source_digest text, verified_at timestamptz, version bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
  workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, kind text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','dead_letter')),
  payload jsonb NOT NULL DEFAULT '{}', result jsonb, attempts integer NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), origin_timezone text NOT NULL DEFAULT 'UTC',
  PRIMARY KEY (workspace_id,id)
);
CREATE TABLE IF NOT EXISTS outbox (
  workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, kind text NOT NULL,
  resource_id text NOT NULL, payload jsonb NOT NULL, published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(workspace_id,created_at,id) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS migration_runs (
  workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
  manifest jsonb NOT NULL, state text NOT NULL, checkpoint jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workspace','conversations','messages','idempotency_receipts',
    'storage_migration_state','jobs','outbox','migration_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='tenant') THEN
      EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id = current_setting(''relay.workspace_id'',true)) WITH CHECK (workspace_id = current_setting(''relay.workspace_id'',true))',t);
    END IF;
  END LOOP;
END $$;
