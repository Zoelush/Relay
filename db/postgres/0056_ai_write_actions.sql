-- Write actions for Zoe (phase 09, step D3; docs/ACTIONS_STEP3.md), behind `ai_actions_v1`. Additive.

-- A connector may now change things (write). Zoe may use a write connector only after a manager
-- turns its writes on, past a warning; who and when is kept.
ALTER TABLE ai_connectors DROP CONSTRAINT ai_connectors_access_check;
ALTER TABLE ai_connectors ADD CONSTRAINT ai_connectors_access_check CHECK(access IN ('read','write'));
ALTER TABLE ai_connectors
 ADD COLUMN writes_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN writes_enabled_by text, ADD COLUMN writes_enabled_at timestamptz,
 ADD CONSTRAINT ai_connectors_writes_check CHECK(NOT writes_enabled OR access='write');

-- The workspace's kill switch: while paused, no write action runs, for Zoe or the test console.
ALTER TABLE ai_agents
 ADD COLUMN writes_paused boolean NOT NULL DEFAULT false,
 ADD COLUMN writes_paused_by text, ADD COLUMN writes_paused_at timestamptz;

-- A teammate's approval of one write, asked for in the conversation (a team-only note) while the
-- procedure waits. It expires after 24 hours.
CREATE TABLE ai_action_approvals (
 workspace_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL, run_id text NOT NULL,
 connector_id text NOT NULL, connector_version integer NOT NULL, step integer NOT NULL,
 -- What would be sent, sensitive inputs redacted.
 summary jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','expired','cancelled')),
 note_part_id text,
 requested_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 decided_by text, decided_at timestamptz, note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,id),
 CHECK((status='pending')=(decided_at IS NULL)),
 FOREIGN KEY(workspace_id,run_id) REFERENCES ai_procedure_runs(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE UNIQUE INDEX ai_action_approvals_pending ON ai_action_approvals(workspace_id,run_id) WHERE status='pending';
CREATE INDEX ai_action_approvals_expiry ON ai_action_approvals(workspace_id,expires_at) WHERE status='pending';
ALTER TABLE ai_action_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ai_action_approvals USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- The audit gains the approval a write ran under, and the idempotency key it was sent with.
ALTER TABLE ai_connector_calls ADD COLUMN approval_id text, ADD COLUMN idempotency_key text;
