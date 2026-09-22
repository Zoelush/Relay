-- Additive privacy boundary. Existing customer uploads remain public;
-- legacy agent uploads fail closed until explicitly classified by an operator.
ALTER TABLE attachments ADD COLUMN audience text NOT NULL DEFAULT 'internal'
 CHECK(audience IN ('customer_visible','internal'));
ALTER TABLE attachments ADD COLUMN owner_teammate_id text;
ALTER TABLE attachments ADD CONSTRAINT attachment_teammate_owner
 FOREIGN KEY(workspace_id,owner_teammate_id) REFERENCES teammates(workspace_id,id);
UPDATE attachments SET audience='customer_visible' WHERE owner_identity_id IS NOT NULL;
INSERT INTO workspace_features(workspace_id,name,enabled)
 SELECT id,'agent_inbox_v1',false FROM workspace ON CONFLICT DO NOTHING;
-- Enforce this at storage as well as in delivery projection.
ALTER TABLE conversation_parts ADD CONSTRAINT internal_notes_stay_internal
 CHECK(kind<>'internal_note' OR audience='internal') NOT VALID;
ALTER TABLE conversation_parts VALIDATE CONSTRAINT internal_notes_stay_internal;
