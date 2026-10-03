-- Rollback for 0037_settings: the new teammate columns stay (additive) and the previous version
-- ignores them; replies stop carrying signatures because the previous composer never adds them.
-- The flag goes off everywhere, hiding the Settings area.
UPDATE workspace_features SET enabled=false WHERE name='settings_v1';
