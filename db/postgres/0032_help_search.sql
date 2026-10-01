-- Help center search and feedback (phase 07, step B2). Additive.
-- Search: one row per published record and language, with accents removed before indexing, the
-- language's own stemming (`config`), and trigram indexes for typo-tolerant matching.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE knowledge_search (
 workspace_id text NOT NULL, record_id text NOT NULL, locale text NOT NULL,
 config regconfig NOT NULL, title text NOT NULL, title_norm text NOT NULL, body_norm text NOT NULL,
 document tsvector NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,record_id,locale),
 FOREIGN KEY(workspace_id,record_id,locale) REFERENCES knowledge_locales(workspace_id,record_id,locale));
CREATE INDEX knowledge_search_document ON knowledge_search USING gin(document);
CREATE INDEX knowledge_search_title_trgm ON knowledge_search USING gin(title_norm gin_trgm_ops);
CREATE INDEX knowledge_search_body_trgm ON knowledge_search USING gin(body_norm gin_trgm_ops);
-- What customers search for, so the content team learns what they cannot find. The query is
-- stored with email addresses and long numbers removed, and kept for 180 days.
CREATE TABLE help_search_queries (
 workspace_id text NOT NULL, id text NOT NULL, center_id text NOT NULL, locale text NOT NULL,
 surface text NOT NULL CHECK(surface IN ('help_center','messenger')),
 query text NOT NULL CHECK(length(query) BETWEEN 1 AND 200), normalized text NOT NULL,
 results integer NOT NULL CHECK(results>=0), opened_record_id text, opened_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,center_id) REFERENCES help_centers(workspace_id,id));
CREATE INDEX help_search_queries_by_center ON help_search_queries(workspace_id,center_id,created_at DESC);
CREATE INDEX help_search_queries_by_age ON help_search_queries(created_at);
-- Was this helpful? One row per vote; a comment can follow a "No".
CREATE TABLE knowledge_feedback (
 workspace_id text NOT NULL, id text NOT NULL, record_id text NOT NULL, locale text NOT NULL,
 surface text NOT NULL CHECK(surface IN ('help_center','messenger')), helpful boolean NOT NULL,
 comment text CHECK(comment IS NULL OR length(comment) BETWEEN 1 AND 1000),
 identity_id text, conversation_id text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,record_id) REFERENCES knowledge_records(workspace_id,id));
CREATE INDEX knowledge_feedback_by_record ON knowledge_feedback(workspace_id,record_id,created_at DESC);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['knowledge_search','help_search_queries','knowledge_feedback'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
