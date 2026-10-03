-- The AI agent, step A3: the resolution ledger. One row per resolution (the customer confirmed it,
-- or didn't come back within the agent's resolution window after an answer, never handed over),
-- and a reversal row when a resolved conversation is handed to the team within that window.
-- Rows are never changed or deleted: billing (phase 16) reads the net. Additive.
ALTER TABLE ai_agents ADD COLUMN resolution_window_hours integer NOT NULL DEFAULT 24
 CHECK(resolution_window_hours IN (1,4,12,24,48,72));
CREATE TABLE ai_resolutions (
 workspace_id text NOT NULL, id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('resolution','reversal')),
 -- A reversal names the resolution it reverses.
 resolution_id text, conversation_id text NOT NULL, agent_id text NOT NULL,
 rule text NOT NULL CHECK(rule IN ('confirmed','quiet_window','handed_over')),
 -- The AI answers (ai_answers ids) the resolution rests on, and their reply parts in the thread.
 answer_ids text[] NOT NULL DEFAULT '{}', reply_part_ids text[] NOT NULL DEFAULT '{}',
 window_hours integer NOT NULL, detail text NOT NULL DEFAULT '',
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 CHECK((kind='reversal')=(resolution_id IS NOT NULL)),
 CHECK((kind='reversal')=(rule='handed_over')),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES ai_agents(workspace_id,id),
 FOREIGN KEY(workspace_id,resolution_id) REFERENCES ai_resolutions(workspace_id,id));
CREATE UNIQUE INDEX ai_resolutions_one_reversal ON ai_resolutions(workspace_id,resolution_id) WHERE kind='reversal';
CREATE INDEX ai_resolutions_conversation ON ai_resolutions(workspace_id,conversation_id,recorded_at);
CREATE INDEX ai_resolutions_recorded ON ai_resolutions(workspace_id,recorded_at);
CREATE FUNCTION keep_ai_resolutions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'The resolution ledger is append-only'; END $$;
CREATE TRIGGER immutable_ai_resolutions BEFORE UPDATE OR DELETE ON ai_resolutions FOR EACH ROW EXECUTE FUNCTION keep_ai_resolutions();
ALTER TABLE ai_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ai_resolutions USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
