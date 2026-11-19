-- Rollback for 0105_app_versions: the earlier code reads each app's draft as what everyone runs,
-- and lets any workspace install any app. Installations keep working, on the draft. The versions
-- and what each installation consented to are dropped with this step's columns and table.
ALTER TABLE oauth_grants DROP COLUMN app_version;
DROP TABLE oauth_app_versions;
DROP FUNCTION oauth_app_versions_kept();
