-- Rollback for 0029_knowledge: additive, so nothing is dropped. The previous version has no
-- knowledge routes; turning `knowledge_v1` off hides them. Records and revisions are kept.
UPDATE workspace_features SET enabled=false WHERE name='knowledge_v1';
