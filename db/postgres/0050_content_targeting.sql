-- Content targeting (phase 08, step Z3b; docs/AI_STEP8.md). Additive.

-- Who Zoe uses an item for: everyone who may see it (no conditions), or only customers and
-- conversations matching these conditions (the escalation rules' closed list), all or any.
-- Zoe only: the help center and the messenger's Help space keep their own visibility.
ALTER TABLE knowledge_records
 ADD COLUMN ai_match text NOT NULL DEFAULT 'all' CHECK(ai_match IN ('all','any')),
 ADD COLUMN ai_conditions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(ai_conditions)='array');
-- Retrieval reads the targeted records on every answer: few of them, found fast.
CREATE INDEX knowledge_records_targeted ON knowledge_records(workspace_id) WHERE ai_conditions <> '[]'::jsonb;

-- A website's targeting applies to every page of it, copied onto them as its audience is.
ALTER TABLE knowledge_sources
 ADD COLUMN ai_match text NOT NULL DEFAULT 'all' CHECK(ai_match IN ('all','any')),
 ADD COLUMN ai_conditions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(ai_conditions)='array');

-- Each answer records the items targeting kept from her for that customer (for teammates).
ALTER TABLE ai_answers ADD COLUMN targeted_out text[] NOT NULL DEFAULT '{}';
