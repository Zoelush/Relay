-- Zoe's specialists (phase 08, step Z3a; docs/AI_STEP7.md). Additive.

-- A specialist is a narrower Zoe for one job: what she handles (her instructions, and how she's
-- picked), keywords checked in code, optional conditions on the customer and conversation (the
-- escalation rules' closed list), her knowledge (all of Zoe's, or chosen help center
-- collections, websites, snippets and files), and the team she hands over to. Customers always
-- see Zoe. Removing one archives it, so answers and conversations keep her name.
CREATE TABLE ai_specialists (
 workspace_id text NOT NULL, id text NOT NULL, agent_id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
 handles text NOT NULL CHECK(length(handles) BETWEEN 1 AND 500),
 keywords text[] NOT NULL DEFAULT '{}' CHECK(cardinality(keywords) <= 20),
 match text NOT NULL DEFAULT 'all' CHECK(match IN ('all','any')),
 conditions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(conditions)='array'),
 knowledge_all boolean NOT NULL DEFAULT true,
 collections text[] NOT NULL DEFAULT '{}',
 websites text[] NOT NULL DEFAULT '{}',
 snippets boolean NOT NULL DEFAULT false,
 files boolean NOT NULL DEFAULT false,
 handover_team_id text,
 enabled boolean NOT NULL DEFAULT true,
 archived boolean NOT NULL DEFAULT false,
 position integer NOT NULL DEFAULT 0,
 version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), updated_by text,
 PRIMARY KEY(workspace_id,id),
 -- A specialist with chosen knowledge has some.
 CHECK(knowledge_all OR cardinality(collections) > 0 OR cardinality(websites) > 0 OR snippets OR files),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES ai_agents(workspace_id,id),
 FOREIGN KEY(workspace_id,handover_team_id) REFERENCES teams(workspace_id,id));
ALTER TABLE ai_specialists ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_specialists FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ai_specialists USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- The specialist that took a conversation, chosen at Zoe's first real question there and kept
-- (null: Zoe herself). ai_routed_at says it has been chosen; until then, greetings don't settle it.
ALTER TABLE conversations
 ADD COLUMN ai_specialist_id text,
 ADD COLUMN ai_routed_at timestamptz,
 ADD CONSTRAINT conversations_ai_specialist_fk FOREIGN KEY(workspace_id,ai_specialist_id) REFERENCES ai_specialists(workspace_id,id);

-- Each answer records the specialist that gave it, and why she took the conversation.
ALTER TABLE ai_answers ADD COLUMN specialist_id text, ADD COLUMN specialist_reason text;
