-- The public help center (phase 07, step B1). A help center can be for everyone or for signed-in
-- customers only (the portal's verified session), and an article can be marked as an FAQ, which
-- gives it FAQ structured data. The public pages have their own flag, off by default, because
-- they are the first knowledge surface customers can see. Additive.
ALTER TABLE help_centers ADD COLUMN access text NOT NULL DEFAULT 'public' CHECK(access IN ('public','signed_in'));
ALTER TABLE knowledge_records ADD COLUMN faq boolean NOT NULL DEFAULT false;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'help_center_v1',false FROM workspace ON CONFLICT DO NOTHING;
