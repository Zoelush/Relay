-- Inline images. Additive: an upload's purpose, and which sent parts reference which images.
-- `inline` uploads are scanned like any file but never published as their own part.
ALTER TABLE attachments ADD COLUMN purpose text NOT NULL DEFAULT 'part' CHECK(purpose IN ('part','inline'));
-- Written when a message is sent. Customers may download an inline image only when a public
-- part references it, and retention deletes inline uploads no part or draft references.
CREATE TABLE conversation_part_images (
 workspace_id text NOT NULL, part_id text NOT NULL, attachment_id text NOT NULL,
 PRIMARY KEY(workspace_id,part_id,attachment_id),
 FOREIGN KEY(workspace_id,part_id) REFERENCES conversation_parts(workspace_id,id),
 FOREIGN KEY(workspace_id,attachment_id) REFERENCES attachments(workspace_id,id)
);
CREATE INDEX conversation_part_images_by_attachment ON conversation_part_images(workspace_id,attachment_id);
CREATE INDEX attachments_inline_age ON attachments(workspace_id,created_at) WHERE purpose='inline';
ALTER TABLE conversation_part_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_part_images FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON conversation_part_images USING (workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK (workspace_id=current_setting('relay.workspace_id',true));
