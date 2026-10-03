-- Rollback for 0036_knowledge_index: the tables stay (additive) and the previous version ignores
-- them. The trigger goes first, so the previous version's publishing stops queueing records for
-- indexing, and the flag is switched off everywhere. Vectors already in the vector store are left
-- unused: nothing reads them without the index tables, and a later re-deploy rebuilds the index.
DROP TRIGGER IF EXISTS knowledge_index_dirty ON knowledge_locales;
DROP FUNCTION IF EXISTS relay_knowledge_dirty();
UPDATE workspace_features SET enabled=false WHERE name='knowledge_index_v1';
