-- Messenger settings, step M5: images a brand uploads for its messenger (the Home screen logo, the
-- launcher logo and Home's background). Uploads follow the attachment path: quarantine, a scan job
-- that checks size and real type, then a clean copy. The messenger config refers to one as
-- "asset:<id>"; customers are served only those its published messenger uses. Additive.
CREATE TABLE brand_assets (
 workspace_id text NOT NULL, id text NOT NULL, brand_id text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('home_logo','launcher_logo','home_background')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 1048576),
 mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/gif')),
 object_key text NOT NULL, clean_key text, checksum text,
 status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','scanning','ready','rejected')),
 failure_code text, job_id text, uploaded_by text,
 created_at timestamptz NOT NULL DEFAULT now(), ready_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));
CREATE INDEX brand_assets_brand ON brand_assets(workspace_id,brand_id,created_at);
ALTER TABLE brand_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON brand_assets USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
