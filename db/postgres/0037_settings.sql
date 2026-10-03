-- Settings (S1): a teammate's own timezone, reply signature and notification preferences, which
-- follow the account rather than the browser; and the flag for the Settings area. Additive.
ALTER TABLE teammates ADD COLUMN timezone text CHECK(timezone IS NULL OR length(timezone) BETWEEN 1 AND 64);
ALTER TABLE teammates ADD COLUMN signature text NOT NULL DEFAULT '' CHECK(length(signature)<=1000);
ALTER TABLE teammates ADD COLUMN notification_prefs jsonb NOT NULL DEFAULT '{}';
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'settings_v1',false FROM workspace ON CONFLICT DO NOTHING;
