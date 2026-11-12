-- The help center's rebuild (November 2026; docs/HELP_CENTER_DESIGN.md). Additive.
-- A help center can be set not live (nothing is served), and its theme can use more images of
-- its own (the hero's background, a footer logo, collection images, a content section's
-- background): one more purpose for its uploaded, scanned files.
ALTER TABLE help_centers ADD COLUMN live boolean NOT NULL DEFAULT true;

ALTER TABLE knowledge_files DROP CONSTRAINT knowledge_files_purpose_check;
ALTER TABLE knowledge_files ADD CONSTRAINT knowledge_files_purpose_check
 CHECK(purpose IN ('source','article_image','theme_logo','theme_favicon','social_image','theme_image'));
ALTER TABLE knowledge_files DROP CONSTRAINT knowledge_files_check1;
ALTER TABLE knowledge_files ADD CONSTRAINT knowledge_files_check1
 CHECK((purpose IN ('theme_logo','theme_favicon','social_image','theme_image')) = (center_id IS NOT NULL));
