-- Rollback for 0084_two_factor: two-factor is no longer required and both allowlists are emptied,
-- so nobody is locked out by settings the earlier code doesn't read. Open challenges end. The
-- tables, the sealed keys and the audit log's records stay.
UPDATE security_settings SET require_two_factor=false,app_allowlist='{}',api_allowlist='{}' WHERE require_two_factor OR cardinality(app_allowlist)>0 OR cardinality(api_allowlist)>0;
UPDATE teammate_challenges SET used_at=now() WHERE used_at IS NULL;
