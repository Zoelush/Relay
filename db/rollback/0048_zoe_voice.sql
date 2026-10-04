-- Rollback for 0048_zoe_voice: nothing to undo. The previous version neither reads nor writes the
-- new agent columns, the guidance versions (kept: they record what answers were given, and are
-- never changed) or the new answer columns, so Zoe answers as before: friendly, standard length,
-- in the customer's browser language, with no answer guidance.
SELECT 1;
