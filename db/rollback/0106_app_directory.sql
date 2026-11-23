-- Rollback for 0106_app_directory: the earlier code has no directory and no review. Apps keep their
-- versions and installations keep working. What is lost is the directory itself, the record of
-- every review, suspensions (a suspended app works again everywhere) and apps' install addresses.
-- Logged uninstall notices are removed before the narrower check returns.
DELETE FROM canvas_calls WHERE kind='uninstalled';
ALTER TABLE canvas_calls DROP CONSTRAINT canvas_calls_kind_check;
ALTER TABLE canvas_calls ADD CONSTRAINT canvas_calls_kind_check CHECK(kind IN ('initialize','submit','configure'));
DROP TABLE app_suspensions;
DROP TABLE app_listings;
DROP TABLE app_submissions;
ALTER TABLE oauth_app_versions DROP COLUMN install_url;
ALTER TABLE oauth_apps DROP COLUMN listed_card;
ALTER TABLE oauth_apps DROP COLUMN install_url;
