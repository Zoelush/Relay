-- The AI agent, step A2a: handing conversations to the team. Additive.

-- Where the agent stands with a conversation, beside its status: waiting on the customer after a
-- reply (pending), handed to the team (escalated), or handed over while the team was away (needs
-- teammate input). Resolved arrives with the resolution ledger (A3). Null: the agent never took
-- part.
ALTER TABLE conversations ADD COLUMN ai_state text
 CHECK(ai_state IN ('pending','escalated','needs_input','resolved'));

-- How each agent hands over: to which team (routed as phase 06 routes any team's conversations),
-- when it answers at all, and what it does outside office hours.
ALTER TABLE ai_agents
 ADD COLUMN handover_team_id text,
 ADD COLUMN answer_hours text NOT NULL DEFAULT 'always' CHECK(answer_hours IN ('always','outside_office_hours')),
 ADD COLUMN out_of_hours text NOT NULL DEFAULT 'reply_time' CHECK(out_of_hours IN ('continue','take_message','reply_time')),
 ADD COLUMN failed_limit integer NOT NULL DEFAULT 2 CHECK(failed_limit BETWEEN 1 AND 5),
 ADD COLUMN escalate_on_sentiment boolean NOT NULL DEFAULT true;

-- Every handover: the trigger, the team it went to, and the summary note. Also an `ai_answers`
-- outcome, so "Why this reply" explains it.
ALTER TABLE ai_answers DROP CONSTRAINT ai_answers_outcome_check;
ALTER TABLE ai_answers ADD CONSTRAINT ai_answers_outcome_check
 CHECK(outcome IN ('answered','clarified','unknown','skipped','failed','escalated'));
ALTER TABLE ai_answers ADD COLUMN trigger text, ADD COLUMN handover_team_id text;

-- Escalation rules: deterministic conditions on the person, company or conversation; when one
-- matches, the agent doesn't answer and hands over (used from step A2b).
CREATE TABLE ai_escalation_rules (
 workspace_id text NOT NULL, id text NOT NULL, agent_id text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 conditions jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, position integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,agent_id) REFERENCES ai_agents(workspace_id,id));
ALTER TABLE ai_escalation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_escalation_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ai_escalation_rules USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
