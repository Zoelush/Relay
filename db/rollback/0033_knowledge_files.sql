-- Rollback for 0033_knowledge_files: additive, so nothing is dropped. The previous version cannot
-- upload knowledge files; existing file records keep their published text and stay searchable,
-- and stored objects remain until a later version removes them.
SELECT 1;
