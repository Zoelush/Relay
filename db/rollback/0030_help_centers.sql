-- Rollback for 0030_help_centers: additive, so nothing is dropped. The previous version ignores
-- the help center tables and article slugs; nothing public is served from them before phase 07
-- step B1, and `knowledge_v1` (off by default) still hides the Knowledge section.
SELECT 1;
