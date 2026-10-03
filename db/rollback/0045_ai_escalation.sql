-- Rollback for 0045_ai_escalation: the columns stay (additive) and the previous version neither
-- reads nor writes them; escalation rules in `ai_escalation_rules` are likewise ignored. Nothing to
-- undo, so a rolled-back agent stops applying topics, guidance and rules until this version returns.
SELECT 1;
