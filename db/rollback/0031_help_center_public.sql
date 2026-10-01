-- Rollback for 0031_help_center_public: additive, so nothing is dropped. Turning the flag off
-- takes the public help center offline; the previous version ignores the new columns.
UPDATE workspace_features SET enabled=false WHERE name='help_center_v1';
