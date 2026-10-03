-- Content health (phase 07, step C2b): near-duplicate checks over the AI index. A check walks the
-- active index version's chunks and records pairs of different records whose passages are 0.92
-- or more alike by cosine similarity. The report shows the latest finished check's pairs while
-- the next one runs. Dismissed pairs stay hidden until either record publishes a change. Additive.
CREATE TABLE knowledge_duplicate_runs (
 workspace_id text NOT NULL, id text NOT NULL, generation_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('running','done','failed')),
 -- Chunks checked so far (by chunk id), the total when it started, and the pairs found.
 cursor text, chunks_total integer NOT NULL DEFAULT 0, chunks_done integer NOT NULL DEFAULT 0,
 pairs integer NOT NULL DEFAULT 0, error text,
 started_by text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,generation_id) REFERENCES knowledge_index_generations(workspace_id,id));
CREATE UNIQUE INDEX knowledge_duplicate_one_running ON knowledge_duplicate_runs(workspace_id) WHERE status='running';

-- A pair is stored once, record_a < record_b, with the closest two passages' similarity.
CREATE TABLE knowledge_duplicate_pairs (
 workspace_id text NOT NULL, run_id text NOT NULL, record_a text NOT NULL, record_b text NOT NULL,
 score real NOT NULL CHECK(score BETWEEN 0 AND 1.0001),
 PRIMARY KEY(workspace_id,run_id,record_a,record_b), CHECK(record_a<record_b),
 FOREIGN KEY(workspace_id,run_id) REFERENCES knowledge_duplicate_runs(workspace_id,id));

CREATE TABLE knowledge_duplicate_dismissals (
 workspace_id text NOT NULL, record_a text NOT NULL, record_b text NOT NULL,
 dismissed_by text NOT NULL, dismissed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,record_a,record_b), CHECK(record_a<record_b));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['knowledge_duplicate_runs','knowledge_duplicate_pairs','knowledge_duplicate_dismissals'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'knowledge_health_v1',false FROM workspace ON CONFLICT DO NOTHING;
