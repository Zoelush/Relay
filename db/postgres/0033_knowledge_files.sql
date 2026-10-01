-- Knowledge files (phase 07, step C1a). Uploaded documents become `file` knowledge records once
-- scanned and their text extracted; images belong to an article or a help center's theme. The
-- bytes live in object storage (quarantine, then a clean copy after the scan), never here.
-- Additive.
CREATE TABLE knowledge_files (
 workspace_id text NOT NULL, id text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('source','article_image','theme_logo','theme_favicon','social_image')),
 record_id text, center_id text,
 CHECK((purpose IN ('source','article_image')) = (record_id IS NOT NULL)),
 CHECK((purpose IN ('theme_logo','theme_favicon','social_image')) = (center_id IS NOT NULL)),
 locale text, version integer NOT NULL DEFAULT 1,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200), size bigint NOT NULL CHECK(size BETWEEN 1 AND 20971520),
 mime text NOT NULL, object_key text NOT NULL, clean_key text, checksum text,
 status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','scanning','ready','rejected','failed','replaced','removed')),
 failure_code text, pages integer, chars integer, truncated boolean NOT NULL DEFAULT false,
 job_id text, uploaded_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), ready_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,record_id) REFERENCES knowledge_records(workspace_id,id),
 FOREIGN KEY(workspace_id,center_id) REFERENCES help_centers(workspace_id,id),
 FOREIGN KEY(workspace_id,uploaded_by) REFERENCES teammates(workspace_id,id));
CREATE INDEX knowledge_files_by_record ON knowledge_files(workspace_id,record_id,version DESC);
CREATE INDEX knowledge_files_by_center ON knowledge_files(workspace_id,center_id);
ALTER TABLE knowledge_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON knowledge_files USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
