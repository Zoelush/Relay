-- Data-safe rollback of target authority. Execute inside a workspace-scoped transaction.
-- Never point writes at D1 until the private reverse export has been verified and restored.
UPDATE storage_migration_state SET authority='frozen',epoch=epoch+1,version=version+1
 WHERE workspace_id=current_setting('relay.workspace_id',true);
-- Target tables, receipts and copied data remain intact. No DROP or rename.
