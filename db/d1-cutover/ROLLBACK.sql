-- Only after verifying the PostgreSQL-to-D1 reverse copy, or proving PostgreSQL accepted no writes.
-- The triggers and fence table remain installed for a later cutover attempt.
UPDATE relay_write_fence SET authority='d1',epoch=epoch+1,changed_at=unixepoch()*1000 WHERE workspace_id='main';
