-- The AI agent (phase 08, step A1): answering in the messenger from the knowledge store. Additive.

-- Keyword search over the AI index's passages, so retrieval can combine words and meaning. Each
-- passage is indexed in its own language's text search configuration (as help center search).
CREATE FUNCTION relay_text_config(locale text) RETURNS regconfig LANGUAGE sql IMMUTABLE AS $$
 SELECT (CASE lower(split_part(locale,'-',1))
   WHEN 'ar' THEN 'arabic'
   WHEN 'hy' THEN 'armenian'
   WHEN 'eu' THEN 'basque'
   WHEN 'ca' THEN 'catalan'
   WHEN 'da' THEN 'danish'
   WHEN 'nl' THEN 'dutch'
   WHEN 'en' THEN 'english'
   WHEN 'et' THEN 'estonian'
   WHEN 'fi' THEN 'finnish'
   WHEN 'fr' THEN 'french'
   WHEN 'de' THEN 'german'
   WHEN 'el' THEN 'greek'
   WHEN 'hi' THEN 'hindi'
   WHEN 'hu' THEN 'hungarian'
   WHEN 'id' THEN 'indonesian'
   WHEN 'ga' THEN 'irish'
   WHEN 'it' THEN 'italian'
   WHEN 'lt' THEN 'lithuanian'
   WHEN 'ne' THEN 'nepali'
   WHEN 'nb' THEN 'norwegian'
   WHEN 'nn' THEN 'norwegian'
   WHEN 'no' THEN 'norwegian'
   WHEN 'pt' THEN 'portuguese'
   WHEN 'ro' THEN 'romanian'
   WHEN 'ru' THEN 'russian'
   WHEN 'sr' THEN 'serbian'
   WHEN 'es' THEN 'spanish'
   WHEN 'sv' THEN 'swedish'
   WHEN 'ta' THEN 'tamil'
   WHEN 'tr' THEN 'turkish'
   WHEN 'yi' THEN 'yiddish'
   ELSE 'simple' END)::regconfig
$$;
CREATE FUNCTION relay_unaccent_lower(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT lower(translate(t,
  'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÇçÑñÝýÿ',
  'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuCcNnYyy'))
$$;
ALTER TABLE knowledge_chunks ADD COLUMN document tsvector;
CREATE FUNCTION relay_chunk_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.document := setweight(to_tsvector(relay_text_config(NEW.locale),relay_unaccent_lower(NEW.heading)),'A')
  || setweight(to_tsvector(relay_text_config(NEW.locale),relay_unaccent_lower(NEW.text)),'B');
 RETURN NEW;
END $$;
CREATE TRIGGER knowledge_chunk_document BEFORE INSERT OR UPDATE OF heading,text,locale ON knowledge_chunks
 FOR EACH ROW EXECUTE FUNCTION relay_chunk_document();
UPDATE knowledge_chunks SET text=text;
CREATE INDEX knowledge_chunks_document ON knowledge_chunks USING gin(document);

-- An AI agent: one per workspace in this step ("default"); several, with guidance and targeting,
-- arrive in step B1. Retrieval below `confidence_threshold` never reaches the model.
CREATE TABLE ai_agents (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL, name text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 confidence_threshold real NOT NULL DEFAULT 0.5 CHECK(confidence_threshold BETWEEN 0 AND 1),
 version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id));

-- Every time the agent considers a customer message: what it retrieved and scored, what it did
-- and why. For teammates and evaluation only; never delivered to a customer.
CREATE TABLE ai_answers (
 workspace_id text NOT NULL, id text NOT NULL, agent_id text NOT NULL, conversation_id text NOT NULL,
 question_part_id text NOT NULL, reply_part_id text,
 outcome text NOT NULL CHECK(outcome IN ('answered','clarified','unknown','skipped','failed')),
 reason text NOT NULL, top_score real, threshold real NOT NULL,
 passages jsonb NOT NULL DEFAULT '[]', cited text[] NOT NULL DEFAULT '{}',
 model text, prompt_version text NOT NULL, latency_ms integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,question_part_id),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES ai_agents(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,question_part_id) REFERENCES conversation_parts(workspace_id,id),
 FOREIGN KEY(workspace_id,reply_part_id) REFERENCES conversation_parts(workspace_id,id));
CREATE INDEX ai_answers_conversation ON ai_answers(workspace_id,conversation_id,created_at);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ai_agents','ai_answers'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'ai_agent_v1',false FROM workspace ON CONFLICT DO NOTHING;
