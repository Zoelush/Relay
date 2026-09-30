-- Routing and workload (phase 06, step A). A team inbox has an assignment method (manual,
-- round robin or balanced), an inbox limit, an optional separate ticket limit, whether tickets
-- count toward conversation capacity, whether round robin includes away teammates, and a
-- rotation cursor. Teammates have their own limits. Capacity is counted from the conversations
-- themselves while the team and teammate rows are locked, so it cannot drift. Additive.
ALTER TABLE teams ADD COLUMN method text NOT NULL DEFAULT 'manual' CHECK(method IN ('manual','round_robin','balanced'));
ALTER TABLE teams ADD COLUMN conversation_limit integer CHECK(conversation_limit IS NULL OR conversation_limit BETWEEN 1 AND 100000);
ALTER TABLE teams ADD COLUMN ticket_limit integer CHECK(ticket_limit IS NULL OR ticket_limit BETWEEN 1 AND 100000);
ALTER TABLE teams ADD COLUMN tickets_count boolean NOT NULL DEFAULT true;
ALTER TABLE teams ADD COLUMN include_away boolean NOT NULL DEFAULT false;
ALTER TABLE teams ADD COLUMN rotation_cursor text;
ALTER TABLE teams ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE teammates ADD COLUMN conversation_limit integer CHECK(conversation_limit IS NULL OR conversation_limit BETWEEN 1 AND 10000);
ALTER TABLE teammates ADD COLUMN ticket_limit integer CHECK(ticket_limit IS NULL OR ticket_limit BETWEEN 1 AND 10000);
-- The queue (a team's open, unassigned conversations) and each teammate's open workload.
CREATE INDEX conversations_team_queue ON conversations(workspace_id,team_id,priority DESC,created_at)
 WHERE assigned='' AND status='open' AND merged_into_id IS NULL AND team_id IS NOT NULL;
CREATE INDEX conversations_workload ON conversations(workspace_id,assigned)
 WHERE assigned<>'' AND status='open' AND merged_into_id IS NULL;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'routing_v1',false FROM workspace ON CONFLICT DO NOTHING;
