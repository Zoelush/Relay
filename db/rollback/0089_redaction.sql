-- Rollback for 0089_redaction: every redaction rule is turned off, so text is stored as written
-- again (what was redacted stays redacted), and Zoe sends 10 earlier messages, as before. The
-- tables, columns and audit records stay.
UPDATE redaction_rules SET enabled=false WHERE enabled;
UPDATE ai_agents SET history_messages=10 WHERE history_messages<>10;
