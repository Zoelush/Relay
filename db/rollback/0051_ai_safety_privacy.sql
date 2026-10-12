-- Rollback for 0051_ai_safety_privacy: the previous version ignores the new columns and table.
-- It can't redact, so a workspace that turned redaction on gets its AI agent switched off rather
-- than having personal data sent unredacted; switch it back on knowingly. The record of model
-- calls is kept (it's evidence of what was sent) until it's dropped by hand.
UPDATE ai_agents SET enabled=false,version=version+1,updated_at=now() WHERE redact_personal_data AND enabled;
