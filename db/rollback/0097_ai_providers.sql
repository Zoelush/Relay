-- Rollback for 0097_ai_providers: no workspace has a primary or fallback any more, and the page's
-- flag is off, so every workspace answers with Relay's key again. Limits on the own-key meter are
-- removed (the earlier code doesn't know it). Connections and their sealed keys stay, unused, and
-- so do the new columns: the earlier code counts every resolution under AI resolutions.
UPDATE ai_providers SET role=NULL WHERE role IS NOT NULL;
UPDATE workspace_features SET enabled=false WHERE name='ai_providers_v1' AND enabled;
DELETE FROM usage_limits WHERE meter='ai_resolutions_own_key';
