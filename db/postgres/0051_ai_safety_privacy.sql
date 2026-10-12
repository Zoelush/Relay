-- Safety and privacy for Zoe (phase 08, step B2; docs/AI_STEP9.md). Additive.

-- B2a: a reply the guards in code blocked before it reached the customer, and which guard: her
-- confidential marker (canary), her instructions (prompt), someone else's personal data
-- (personal_data), or internal content (internal). The customer was told she couldn't answer.
-- B2b: the earlier conversations she was given as memory.
ALTER TABLE ai_answers
 ADD COLUMN guard text CHECK(guard IN ('canary','prompt','personal_data','internal')),
 ADD COLUMN remembered text[] NOT NULL DEFAULT '{}';

-- B2b: privacy settings, both off by default. Redaction replaces personal data with placeholders
-- before anything is sent to the model provider; memory gives her a signed-in customer's last
-- three conversations from the past 90 days (public messages only).
ALTER TABLE ai_agents
 ADD COLUMN redact_personal_data boolean NOT NULL DEFAULT false,
 ADD COLUMN memory boolean NOT NULL DEFAULT false;

-- B2b: every call to a model provider for a customer's message, with exactly what was sent
-- (redacted when redaction is on), for audit. Kept 90 days, then purged.
CREATE TABLE ai_model_calls (
 workspace_id text NOT NULL, id text NOT NULL,
 conversation_id text NOT NULL, question_part_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('answer','classify')),
 model text NOT NULL,
 sent text NOT NULL,
 redacted boolean NOT NULL,
 redactions jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(redactions)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE INDEX ai_model_calls_question ON ai_model_calls(workspace_id,question_part_id);
CREATE INDEX ai_model_calls_age ON ai_model_calls(workspace_id,created_at);
ALTER TABLE ai_model_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_model_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ai_model_calls USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
