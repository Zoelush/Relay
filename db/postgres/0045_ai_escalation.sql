-- The AI agent, step A2b: what it must never handle, and natural-language escalation guidance,
-- kept on the agent and versioned with it. Escalation rules use `ai_escalation_rules` (0044).
-- Additive.
ALTER TABLE ai_agents
 ADD COLUMN never_handle jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(never_handle)='array'),
 ADD COLUMN escalation_guidance jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(escalation_guidance)='array');
