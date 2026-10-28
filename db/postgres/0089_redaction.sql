-- Content redaction and model-provider controls (phase 16, step C6b; docs/SECURITY_STEP10.md). Additive.
-- A workspace's redaction rules (built-in detectors, or a custom pattern checked when saved),
-- applied by the server to conversation text as it's stored; how many earlier messages Zoe sends
-- to the model; and, on each model call's record, which controls applied.

CREATE TABLE redaction_rules (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('builtin','custom')),
 builtin text CHECK(builtin IN ('card','iban','us_ssn','uk_ni')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 pattern text CHECK(length(pattern) BETWEEN 1 AND 200),
 enabled boolean NOT NULL DEFAULT true,
 created_by text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 CHECK((kind='builtin') = (builtin IS NOT NULL) AND (kind='custom') = (pattern IS NOT NULL)));
CREATE UNIQUE INDEX redaction_rules_builtin ON redaction_rules(workspace_id,builtin) WHERE builtin IS NOT NULL;
ALTER TABLE redaction_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE redaction_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON redaction_rules USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF name,pattern,enabled ON redaction_rules FOR EACH ROW EXECUTE FUNCTION audit_row('redaction_rule','redaction_rule','id','name');

-- How many earlier messages Zoe sends with a question: none, 5, or 10 (as before).
ALTER TABLE ai_agents ADD COLUMN history_messages int NOT NULL DEFAULT 10 CHECK(history_messages IN (0,5,10));
-- Which controls applied to a model call: redaction, memory, history length, rules in force.
ALTER TABLE ai_model_calls ADD COLUMN controls jsonb NOT NULL DEFAULT '{}';
