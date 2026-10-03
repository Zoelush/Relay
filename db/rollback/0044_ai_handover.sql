-- Rollback for 0044_ai_handover: the columns and table stay (additive); the previous version
-- neither reads nor writes them. Its outcome check doesn't know "escalated", so those audit rows
-- are relabelled "skipped" (their reason still says what happened) before the old check returns.
UPDATE ai_answers SET outcome='skipped' WHERE outcome='escalated';
ALTER TABLE ai_answers DROP CONSTRAINT ai_answers_outcome_check;
ALTER TABLE ai_answers ADD CONSTRAINT ai_answers_outcome_check
 CHECK(outcome IN ('answered','clarified','unknown','skipped','failed'));
