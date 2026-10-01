-- Knowledge store (phase 07, step A1): one record type for everything the help center, the
-- inbox and the AI agent read. A record has a source (public article, internal article,
-- snippet, uploaded file, synced external page), an owner, an audience, independent availability
-- switches and a review date. Its content is per locale: each locale is drafted (autosaved) and
-- published independently, and every publish is kept as a revision that can be restored. Additive.
CREATE TABLE knowledge_records (
 workspace_id text NOT NULL, id text NOT NULL,
 source text NOT NULL CHECK(source IN ('article','internal_article','snippet','file','external_page')),
 owner_id text NOT NULL, audience text NOT NULL DEFAULT 'public' CHECK(audience IN ('public','signed_in','internal')),
 for_ai boolean NOT NULL DEFAULT false, for_help_center boolean NOT NULL DEFAULT false, for_inbox boolean NOT NULL DEFAULT true,
 -- Customer-facing switches never apply to internal content.
 CHECK(NOT (audience='internal' AND (for_ai OR for_help_center))),
 CHECK(NOT for_help_center OR source='article'),
 external_id text, last_reviewed_at timestamptz, reviewed_by text,
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES teammates(workspace_id,id),
 FOREIGN KEY(workspace_id,reviewed_by) REFERENCES teammates(workspace_id,id));
CREATE UNIQUE INDEX knowledge_external ON knowledge_records(workspace_id,source,external_id) WHERE external_id IS NOT NULL;
CREATE TABLE knowledge_locales (
 workspace_id text NOT NULL, record_id text NOT NULL, locale text NOT NULL CHECK(length(locale) BETWEEN 2 AND 35),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
 draft_title text NOT NULL DEFAULT '' CHECK(length(draft_title)<=300), draft_body jsonb,
 draft_version bigint NOT NULL DEFAULT 1, draft_updated_at timestamptz NOT NULL DEFAULT now(), draft_updated_by text,
 published_title text, published_body jsonb, published_text text, published_revision integer,
 published_at timestamptz, published_by text,
 PRIMARY KEY(workspace_id,record_id,locale),
 FOREIGN KEY(workspace_id,record_id) REFERENCES knowledge_records(workspace_id,id));
CREATE TABLE knowledge_revisions (
 workspace_id text NOT NULL, record_id text NOT NULL, locale text NOT NULL, revision integer NOT NULL,
 title text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
 PRIMARY KEY(workspace_id,record_id,locale,revision),
 FOREIGN KEY(workspace_id,record_id,locale) REFERENCES knowledge_locales(workspace_id,record_id,locale));
CREATE INDEX knowledge_records_by_source ON knowledge_records(workspace_id,source,updated_at DESC);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['knowledge_records','knowledge_locales','knowledge_revisions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
-- Revisions are history: never changed or removed.
CREATE TRIGGER immutable_knowledge_revisions BEFORE UPDATE OR DELETE ON knowledge_revisions FOR EACH ROW EXECUTE FUNCTION reject_part_mutation();
-- `knowledge.manage` (write and publish) goes to roles that already manage the workspace.
INSERT INTO role_capabilities(workspace_id,role_id,capability)
 SELECT workspace_id,role_id,'knowledge.manage' FROM role_capabilities WHERE capability='workspace.manage' ON CONFLICT DO NOTHING;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'knowledge_v1',false FROM workspace ON CONFLICT DO NOTHING;
