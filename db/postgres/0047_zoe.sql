-- The AI agent becomes Zoe (phase 08, step Z1). Additive.

-- Workspaces that kept the default name now call her Zoe; a name a workspace chose stays.
ALTER TABLE ai_agents ALTER COLUMN name SET DEFAULT 'Zoe';
UPDATE ai_agents SET name='Zoe' WHERE name='AI agent';

-- Zoe's identity per brand: the name and avatars customers see on her replies (light and dark
-- messenger themes; uploads are brand_assets referenced as "asset:<id>"), an AI disclosure shown
-- above her first reply, and her reply to a greeting in the brand's own language.
CREATE TABLE ai_agent_identities (
 workspace_id text NOT NULL, agent_id text NOT NULL, brand_id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
 avatar text NOT NULL DEFAULT '', avatar_dark text NOT NULL DEFAULT '',
 disclosure text NOT NULL DEFAULT '' CHECK(length(disclosure)<=200),
 greeting text NOT NULL DEFAULT '' CHECK(length(greeting)<=300),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by text,
 PRIMARY KEY(workspace_id,agent_id,brand_id),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES ai_agents(workspace_id,id),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));
ALTER TABLE ai_agent_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ai_agent_identities USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- Zoe's avatars are uploaded like the messenger's images (M5).
ALTER TABLE brand_assets DROP CONSTRAINT brand_assets_purpose_check;
ALTER TABLE brand_assets ADD CONSTRAINT brand_assets_purpose_check
 CHECK(purpose IN ('home_logo','launcher_logo','home_background','agent_avatar','agent_avatar_dark'));
