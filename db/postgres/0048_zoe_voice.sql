-- How Zoe answers (phase 08, step Z2; docs/AI_STEP6.md). Additive.

-- Her voice (tone, answer length, formality), her answer guidance, and her languages, on the
-- agent. Guidance is a list of guidelines (category, title, text, on or off, who and which brand
-- it's for); guidance_version counts saves of the Guidance page (0: never saved, the defaults).
-- Languages are the ones she answers in; a customer writing in another gets the brand's language,
-- or is handed to the team.
ALTER TABLE ai_agents
 ADD COLUMN tone text NOT NULL DEFAULT 'friendly'
  CHECK(tone IN ('friendly','professional','matter_of_fact','empathetic','playful')),
 ADD COLUMN answer_length text NOT NULL DEFAULT 'standard'
  CHECK(answer_length IN ('concise','standard','thorough')),
 ADD COLUMN formality text NOT NULL DEFAULT 'usual'
  CHECK(formality IN ('usual','formal','informal')),
 ADD COLUMN answer_guidance jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(answer_guidance)='array'),
 ADD COLUMN guidance_version integer NOT NULL DEFAULT 0 CHECK(guidance_version >= 0),
 ADD COLUMN languages text[] NOT NULL DEFAULT '{en,fr,es,de,pt,pt-BR,it,nl,ar}'
  CHECK(cardinality(languages) >= 1),
 ADD COLUMN other_languages text NOT NULL DEFAULT 'brand_language'
  CHECK(other_languages IN ('brand_language','hand_over'));

-- Every save of her voice and guidance, never changed: what an answer was given, and what can be
-- restored (a restore is saved again as a new version).
CREATE TABLE ai_guidance_versions (
 workspace_id text NOT NULL, agent_id text NOT NULL, version integer NOT NULL CHECK(version >= 1),
 tone text NOT NULL, answer_length text NOT NULL, formality text NOT NULL,
 guidance jsonb NOT NULL CHECK(jsonb_typeof(guidance)='array'),
 restored_from integer, saved_by text, saved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,agent_id,version),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES ai_agents(workspace_id,id));
CREATE FUNCTION keep_ai_guidance_versions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Guidance versions are never changed'; END $$;
CREATE TRIGGER immutable_ai_guidance_versions BEFORE UPDATE OR DELETE ON ai_guidance_versions FOR EACH ROW EXECUTE FUNCTION keep_ai_guidance_versions();
ALTER TABLE ai_guidance_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_guidance_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ai_guidance_versions USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- What each answer was given: the language she answered in, the one she read in the customer's
-- message (when she could tell), and the guidance version and guidelines that applied. A message
-- she left alone as spam is a skipped answer with the trigger "spam".
ALTER TABLE ai_answers
 ADD COLUMN language text,
 ADD COLUMN detected_language text,
 ADD COLUMN guidance_version integer,
 ADD COLUMN guidance_applied text[] NOT NULL DEFAULT '{}';
