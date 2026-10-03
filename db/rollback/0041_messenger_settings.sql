-- Rollback for 0041_messenger_settings: the flag goes off everywhere. The messenger then ignores
-- the published `messenger3` settings (the boot response leaves them out) and shows what the
-- earlier settings describe; the earlier Settings page edits brands directly again. Drafts and
-- versions stay (additive).
UPDATE workspace_features SET enabled=false WHERE name='messenger_v3';
