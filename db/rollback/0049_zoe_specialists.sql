-- Rollback for 0049_zoe_specialists: the previous version neither reads nor writes specialists,
-- the conversations' specialist columns or the answers' specialist columns, so Zoe answers every
-- conversation herself again, from all her content. The specialists are kept (answers name them).
-- Guidance that targets a specialist (answer_guidance's specialistId) is ignored by the previous
-- version's code, so it would apply always: switch such guidelines off before rolling back.
UPDATE ai_agents SET answer_guidance=(
  SELECT COALESCE(jsonb_agg(CASE WHEN g ? 'specialistId' AND g->>'specialistId' IS NOT NULL
    THEN jsonb_set(g,'{enabled}','false') ELSE g END),'[]'::jsonb)
  FROM jsonb_array_elements(answer_guidance) g);
