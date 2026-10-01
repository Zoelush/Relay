-- Rollback for 0034_knowledge_sync: additive, so nothing is dropped. The previous version cannot
-- sync websites; synced pages stay as published external_page records (searchable, editable
-- settings) until a later version removes them, and the flag row is ignored.
SELECT 1;
