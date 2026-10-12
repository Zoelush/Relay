-- Zoe's review queue (phase 08, step C2a; docs/AI_STEP11.md), behind `zoe_review_v1`. Additive.

-- How many of a day's answers are sampled for review, once the day is over (0 stops sampling;
-- answers customers pushed back on are always added).
ALTER TABLE ai_agents ADD COLUMN review_sample integer NOT NULL DEFAULT 10 CHECK(review_sample BETWEEN 0 AND 50);

-- One row per sampled UTC day, written before the sample, so a retried or concurrent sweep never
-- samples a day twice.
CREATE TABLE ai_review_days (
 workspace_id text NOT NULL, day date NOT NULL,
 sample integer NOT NULL, picked integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,day));

-- An answer Zoe gave from content, in the queue: sampled, or added because the customer pushed
-- back straight after it (asked for a person, or seemed upset). Rated once, by a teammate who
-- manages Zoe; a bad rating says what was wrong. Internal: never shown to a customer.
CREATE TABLE ai_reviews (
 workspace_id text NOT NULL, id text NOT NULL, answer_id text NOT NULL, conversation_id text NOT NULL,
 source text NOT NULL CHECK(source IN ('sample','pushback')),
 pushback text CHECK(pushback IN ('asked_for_person','negative_sentiment')),
 rating text CHECK(rating IN ('good','bad')),
 problem text CHECK(problem IN ('wrong','incomplete','missing_content','outdated_content','tone','should_not_answer')),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
 rated_by text, rated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,answer_id),
 CHECK((source='pushback')=(pushback IS NOT NULL)),
 CHECK((rating IS NULL)=(rated_by IS NULL) AND (rating IS NULL)=(rated_at IS NULL)),
 CHECK(CASE WHEN rating='bad' THEN problem IS NOT NULL ELSE problem IS NULL END),
 FOREIGN KEY(workspace_id,answer_id) REFERENCES ai_answers(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE INDEX ai_reviews_pending ON ai_reviews(workspace_id,created_at) WHERE rating IS NULL;
CREATE INDEX ai_reviews_rated ON ai_reviews(workspace_id,rated_at) WHERE rating IS NOT NULL;

-- A bad answer for missing or outdated content becomes a content gap: the question, her answer
-- and the reviewer's note, until someone fixes it (optionally naming the record) or dismisses it.
-- Zoe's Knowledge gaps and content health list the open ones.
CREATE TABLE ai_content_gaps (
 workspace_id text NOT NULL, id text NOT NULL, review_id text NOT NULL, conversation_id text NOT NULL,
 question text NOT NULL, answer text NOT NULL,
 problem text NOT NULL CHECK(problem IN ('missing_content','outdated_content')),
 note text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','fixed','dismissed')),
 record_id text,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 resolved_by text, resolved_at timestamptz,
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,review_id),
 CHECK((status='open')=(resolved_at IS NULL) AND (status='open')=(resolved_by IS NULL)),
 CHECK(status='fixed' OR record_id IS NULL),
 FOREIGN KEY(workspace_id,review_id) REFERENCES ai_reviews(workspace_id,id));
CREATE INDEX ai_content_gaps_open ON ai_content_gaps(workspace_id,created_at) WHERE status='open';

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ai_review_days','ai_reviews','ai_content_gaps'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'zoe_review_v1',false FROM workspace ON CONFLICT DO NOTHING;
