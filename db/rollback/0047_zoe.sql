-- Rollback for 0047_zoe: the identities table stays (additive) and the previous version ignores
-- it, so customers see the default AI label again. Avatar uploads are removed (nothing in the
-- previous version can show them) so the old purpose check can return. The name Zoe stays: the
-- previous version only uses the name in its prompt.
DELETE FROM brand_assets WHERE purpose IN ('agent_avatar','agent_avatar_dark');
UPDATE ai_agent_identities SET avatar='',avatar_dark='';
ALTER TABLE brand_assets DROP CONSTRAINT brand_assets_purpose_check;
ALTER TABLE brand_assets ADD CONSTRAINT brand_assets_purpose_check
 CHECK(purpose IN ('home_logo','launcher_logo','home_background'));
