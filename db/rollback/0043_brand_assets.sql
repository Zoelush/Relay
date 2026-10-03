-- Rollback for 0043_brand_assets: the table stays (additive). The previous version can't show an
-- uploaded image, so live messengers that use one go back to none: no Home logo, the ✦ in the
-- launcher, and no Home background. Drafts and versions keep their references; the previous
-- version refuses to publish them until they're replaced with https addresses.
UPDATE brands SET settings=settings||'{"logo":""}'::jsonb WHERE settings->>'logo' LIKE 'asset:%';
UPDATE brands SET settings=jsonb_set(settings,'{messenger3,look,launcherLogo}','""')
 WHERE settings#>>'{messenger3,look,launcherLogo}' LIKE 'asset:%';
UPDATE brands SET settings=jsonb_set(jsonb_set(settings,'{messenger3,look,header,image}','""'),'{messenger3,look,header,background}','"none"')
 WHERE settings#>>'{messenger3,look,header,image}' LIKE 'asset:%';
