-- Phase 07, step C1b: website sync. A source (a website, by start address or sitemap) is crawled
-- on a schedule; each page becomes an `external_page` knowledge record. Runs are resumable
-- background jobs with a frontier of addresses still to fetch.
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'knowledge_sync_v1',false FROM workspace ON CONFLICT DO NOTHING;

CREATE TABLE knowledge_sources (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 kind text NOT NULL DEFAULT 'website' CHECK(kind IN ('website')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 start_url text NOT NULL CHECK(length(start_url) <= 2048),
 sitemap_url text CHECK(length(sitemap_url) <= 2048),
 host text NOT NULL,
 locale text NOT NULL,
 exclude text[] NOT NULL DEFAULT '{}',
 strip text[] NOT NULL DEFAULT '{}',
 render_js boolean NOT NULL DEFAULT false,
 audience text NOT NULL DEFAULT 'internal' CHECK(audience IN ('public','signed_in','internal')),
 for_ai boolean NOT NULL DEFAULT false,
 for_inbox boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','removed')),
 interval_days integer NOT NULL DEFAULT 7 CHECK(interval_days IN (7,14)),
 next_run_at timestamptz,
 page_count integer NOT NULL DEFAULT 0,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,id),
 -- Internal content never reaches the AI agent, which answers customers (as for records).
 CHECK(NOT (audience='internal' AND for_ai)),
 FOREIGN KEY(workspace_id,created_by) REFERENCES teammates(workspace_id,id));
CREATE INDEX knowledge_sources_due ON knowledge_sources(workspace_id,next_run_at) WHERE status='active';

CREATE TABLE knowledge_sync_runs (
 workspace_id text NOT NULL, id text NOT NULL, source_id text NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed','cancelled')),
 trigger text NOT NULL CHECK(trigger IN ('manual','schedule')),
 job_id text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 pages_seen integer NOT NULL DEFAULT 0, pages_changed integer NOT NULL DEFAULT 0,
 pages_failed integer NOT NULL DEFAULT 0, pages_removed integer NOT NULL DEFAULT 0,
 failure_code text,
 -- The site's robots.txt as read when the run started (every batch of the run follows it).
 robots text, seeded boolean NOT NULL DEFAULT false, page_limit_reached boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES knowledge_sources(workspace_id,id));
-- At most one run of a source at a time.
CREATE UNIQUE INDEX knowledge_sync_runs_one ON knowledge_sync_runs(workspace_id,source_id) WHERE status='running';
CREATE INDEX knowledge_sync_runs_by_source ON knowledge_sync_runs(workspace_id,source_id,started_at DESC);

CREATE TABLE knowledge_sync_frontier (
 workspace_id text NOT NULL, run_id text NOT NULL, url text NOT NULL,
 -- Fetched in the order found (clock_timestamp differs within a transaction).
 added_at timestamptz NOT NULL DEFAULT clock_timestamp(), done boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,run_id,url),
 FOREIGN KEY(workspace_id,run_id) REFERENCES knowledge_sync_runs(workspace_id,id));
CREATE INDEX knowledge_sync_frontier_next ON knowledge_sync_frontier(workspace_id,run_id,added_at,url) WHERE NOT done;

CREATE TABLE knowledge_source_pages (
 workspace_id text NOT NULL, source_id text NOT NULL,
 external_id text NOT NULL,
 url text NOT NULL,
 record_id text,
 title text,
 etag text, last_modified text, content_hash text,
 fetched_at timestamptz, last_seen_run_id text,
 missed_runs integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed','failed','skipped')),
 failure_code text,
 PRIMARY KEY(workspace_id,source_id,external_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES knowledge_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,record_id) REFERENCES knowledge_records(workspace_id,id));
CREATE INDEX knowledge_source_pages_by_record ON knowledge_source_pages(workspace_id,record_id);

ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON knowledge_sources USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
ALTER TABLE knowledge_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON knowledge_sync_runs USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
ALTER TABLE knowledge_sync_frontier ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sync_frontier FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON knowledge_sync_frontier USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
ALTER TABLE knowledge_source_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_source_pages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON knowledge_source_pages USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
