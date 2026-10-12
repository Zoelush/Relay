-- Rollback for 0055_ai_procedures: the previous version never starts or continues a procedure, and
-- its outcome check doesn't know 'procedure'. Runs waiting for a customer are ended (abandoned), so
-- Zoe answers normally; answer records with the 'procedure' outcome stay readable (the wider check
-- stays). Procedures, versions and runs are kept.
UPDATE ai_procedure_runs SET status='abandoned',reason='Stopped by rollback.',ended_at=now(),updated_at=now(),version=version+1 WHERE status='waiting';
