-- The AI index (phase 07, step C2a): published knowledge split into chunks, embedded by a model,
-- searched by meaning. The vectors themselves live in the vector store (Cloudflare Vectorize when
-- deployed), never here; this database keeps the chunks' text, which index version holds which
-- chunk, and what still needs indexing. Additive.

-- An index version: one model and version for a workspace's vectors. Searches read the single
-- active version while a new one is built beside it, then the switch is one update.
CREATE TABLE knowledge_index_generations (
 workspace_id text NOT NULL, id text NOT NULL,
 model text NOT NULL, model_version text NOT NULL, dimensions integer NOT NULL CHECK(dimensions>0),
 status text NOT NULL CHECK(status IN ('building','active','retired')),
 -- Building: records done so far, the total when it started, and the last record id done.
 total_records integer NOT NULL DEFAULT 0, done_records integer NOT NULL DEFAULT 0, build_cursor text,
 created_by text, created_at timestamptz NOT NULL DEFAULT now(),
 activated_at timestamptz, retired_at timestamptz,
 PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX knowledge_index_one_active ON knowledge_index_generations(workspace_id) WHERE status='active';
CREATE UNIQUE INDEX knowledge_index_one_building ON knowledge_index_generations(workspace_id) WHERE status='building';

-- The chunks of each published locale, in order. `chunk_id` is a hash of the record, locale and
-- text, so unchanged text keeps its id (and its vectors) across edits.
CREATE TABLE knowledge_chunks (
 workspace_id text NOT NULL, record_id text NOT NULL, locale text NOT NULL, position integer NOT NULL,
 chunk_id text NOT NULL, heading text NOT NULL DEFAULT '', text text NOT NULL,
 PRIMARY KEY(workspace_id,record_id,locale,position),
 UNIQUE(workspace_id,chunk_id),
 FOREIGN KEY(workspace_id,record_id) REFERENCES knowledge_records(workspace_id,id));

-- Which chunks an index version holds in the vector store, under which vector id.
CREATE TABLE knowledge_chunk_vectors (
 workspace_id text NOT NULL, generation_id text NOT NULL, chunk_id text NOT NULL,
 record_id text NOT NULL, vector_id text NOT NULL, embedded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,generation_id,chunk_id),
 FOREIGN KEY(workspace_id,generation_id) REFERENCES knowledge_index_generations(workspace_id,id));
CREATE INDEX knowledge_chunk_vectors_record ON knowledge_chunk_vectors(workspace_id,generation_id,record_id);

-- Records whose published content changed since they were last indexed. A new change moves
-- `marked_at`, so the indexer clears a mark only if nothing changed while it worked.
CREATE TABLE knowledge_index_dirty (
 workspace_id text NOT NULL, record_id text NOT NULL, marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,record_id));

-- How often each record was retrieved, per day and purpose (the health report reads this in C2b).
CREATE TABLE knowledge_retrievals (
 workspace_id text NOT NULL, record_id text NOT NULL, day date NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('ai','inbox')), count integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,record_id,day,purpose));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['knowledge_index_generations','knowledge_chunks','knowledge_chunk_vectors','knowledge_index_dirty','knowledge_retrievals'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

-- Any change to what a locale publishes marks its record: manual publishing, file processing and
-- website sync all write knowledge_locales, so none of them has to remember to.
CREATE FUNCTION relay_knowledge_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  INSERT INTO knowledge_index_dirty(workspace_id,record_id) VALUES(OLD.workspace_id,OLD.record_id)
   ON CONFLICT(workspace_id,record_id) DO UPDATE SET marked_at=clock_timestamp();
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR OLD.published_revision IS DISTINCT FROM NEW.published_revision
   OR OLD.published_title IS DISTINCT FROM NEW.published_title OR OLD.published_text IS DISTINCT FROM NEW.published_text THEN
  INSERT INTO knowledge_index_dirty(workspace_id,record_id) VALUES(NEW.workspace_id,NEW.record_id)
   ON CONFLICT(workspace_id,record_id) DO UPDATE SET marked_at=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER knowledge_index_dirty AFTER INSERT OR UPDATE OR DELETE ON knowledge_locales
 FOR EACH ROW EXECUTE FUNCTION relay_knowledge_dirty();

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'knowledge_index_v1',false FROM workspace ON CONFLICT DO NOTHING;
