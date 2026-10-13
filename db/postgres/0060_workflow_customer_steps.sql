-- Customer-facing workflow steps (phase 11, step W3; docs/WORKFLOWS_STEP3.md), behind `workflows_v1`.

-- A workflow's message to the customer: its own kind, delivered like a reply but never counted as
-- a teammate's (first response, SLAs, Zoe stepping back) or as Zoe's.
ALTER TABLE conversation_parts DROP CONSTRAINT conversation_parts_kind_check;
ALTER TABLE conversation_parts ADD CONSTRAINT conversation_parts_kind_check CHECK(kind IN ('customer_message','teammate_reply','internal_note','ai_reply','assignment_change','state_change','priority_change','tag_change','participant_change','attribute_change','rating','attachment','system_event','channel_handover','merge_marker','workflow_message'));

-- A workflow calling a read connector is audited like Zoe's calls, as the workflow.
ALTER TABLE ai_connector_calls DROP CONSTRAINT ai_connector_calls_source_check;
ALTER TABLE ai_connector_calls ADD CONSTRAINT ai_connector_calls_source_check CHECK(source IN ('test','agent','workflow'));

-- Runs waiting for the customer's answer or Zoe's outcome are found by conversation.
CREATE INDEX workflow_runs_waiting ON workflow_runs(workspace_id,conversation_id) WHERE status='waiting';
