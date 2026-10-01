-- Help center structure (phase 07, step A2). At most one help center per brand, each with its
-- languages, theme and homepage layout. Collections hold optional sections (a fixed depth of
-- two); an article can be placed in several collections or sections. Articles, collections,
-- sections and help centers have clean slugs, per language where they have names; every old slug
-- is kept as a redirect to its object, so renamed links keep working. Additive.
ALTER TABLE knowledge_locales ADD COLUMN slug text CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=80);
CREATE UNIQUE INDEX knowledge_locale_slugs ON knowledge_locales(workspace_id,locale,slug) WHERE slug IS NOT NULL;
CREATE TABLE help_centers (
 workspace_id text NOT NULL, id text NOT NULL, brand_id text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 slug text NOT NULL CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=80),
 default_locale text NOT NULL, locales text[] NOT NULL CHECK(default_locale = ANY(locales) AND cardinality(locales) BETWEEN 1 AND 30),
 theme jsonb NOT NULL DEFAULT '{}', layout jsonb NOT NULL DEFAULT '[]', noindex boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,brand_id), UNIQUE(workspace_id,slug),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));
-- Collections (no parent) and sections (parent is a collection of the same help center).
CREATE TABLE help_nodes (
 workspace_id text NOT NULL, id text NOT NULL, center_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('collection','section')), parent_id text,
 CHECK((kind='collection') = (parent_id IS NULL)),
 position integer NOT NULL DEFAULT 0, icon text CHECK(icon IS NULL OR icon ~ '^[a-z-]{1,40}$'),
 archived boolean NOT NULL DEFAULT false, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,center_id) REFERENCES help_centers(workspace_id,id),
 FOREIGN KEY(workspace_id,parent_id) REFERENCES help_nodes(workspace_id,id));
CREATE INDEX help_nodes_by_parent ON help_nodes(workspace_id,center_id,parent_id,position);
CREATE TABLE help_node_locales (
 workspace_id text NOT NULL, node_id text NOT NULL, center_id text NOT NULL, kind text NOT NULL, locale text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), description text NOT NULL DEFAULT '' CHECK(length(description)<=500),
 slug text NOT NULL CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=80),
 PRIMARY KEY(workspace_id,node_id,locale), UNIQUE(workspace_id,center_id,kind,locale,slug),
 FOREIGN KEY(workspace_id,node_id) REFERENCES help_nodes(workspace_id,id));
CREATE TABLE help_placements (
 workspace_id text NOT NULL, node_id text NOT NULL, record_id text NOT NULL, position integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,node_id,record_id),
 FOREIGN KEY(workspace_id,node_id) REFERENCES help_nodes(workspace_id,id),
 FOREIGN KEY(workspace_id,record_id) REFERENCES knowledge_records(workspace_id,id));
CREATE INDEX help_placements_by_record ON help_placements(workspace_id,record_id);
-- Old slugs. scope is the help center for collections and sections, '' for articles and help
-- centers (whose slugs are unique across the workspace). A live slug always wins over a redirect.
CREATE TABLE help_redirects (
 workspace_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('center','collection','section','article')),
 scope text NOT NULL, locale text NOT NULL, slug text NOT NULL, target_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,kind,scope,locale,slug));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['help_centers','help_nodes','help_node_locales','help_placements','help_redirects'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
