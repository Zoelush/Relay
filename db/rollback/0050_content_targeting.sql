-- Rollback for 0050_content_targeting: the previous version ignores targeting, so it would use
-- targeted content for every customer. Zoe is switched off for that content instead (its
-- conditions are kept, so it can be switched back on once targeting returns). Websites too, and
-- their pages.
UPDATE knowledge_records SET for_ai=false,version=version+1,updated_at=now() WHERE for_ai AND ai_conditions <> '[]'::jsonb;
UPDATE knowledge_sources SET for_ai=false,version=version+1,updated_at=now() WHERE for_ai AND ai_conditions <> '[]'::jsonb;
