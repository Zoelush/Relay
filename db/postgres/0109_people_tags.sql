-- Finishing phase 01, P1c (docs/PEOPLE_STEP3.md): tags on contacts and companies, from the same
-- tags as conversations'. Additive.
--
-- A tag on a contact. `source` says who added it: the API, a teammate in the inbox, or a merge
-- (which brought it from a contact merged into this one, and whose reversal takes it away again).
CREATE TABLE contact_tags (
 workspace_id text NOT NULL, contact_id text NOT NULL, tag_id text NOT NULL,
 source text NOT NULL CHECK(source IN ('api','inbox','merge')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,contact_id,tag_id),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id),
 FOREIGN KEY(workspace_id,tag_id) REFERENCES tags(workspace_id,id));
-- A tag's people, for P2's segments.
CREATE INDEX contact_tags_by_tag ON contact_tags(workspace_id,tag_id,contact_id);

-- A tag on a company.
CREATE TABLE company_tags (
 workspace_id text NOT NULL, company_id text NOT NULL, tag_id text NOT NULL,
 source text NOT NULL CHECK(source IN ('api','inbox')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,company_id,tag_id),
 FOREIGN KEY(workspace_id,company_id) REFERENCES companies(workspace_id,id),
 FOREIGN KEY(workspace_id,tag_id) REFERENCES tags(workspace_id,id));
CREATE INDEX company_tags_by_tag ON company_tags(workspace_id,tag_id,company_id);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['contact_tags','company_tags'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

-- Webhooks (as 0078 and 0108): written by the database, in the same transaction. A company being
-- deleted (relay.deleting_company) loses its tags without an untagged event each.
CREATE FUNCTION webhook_contact_tag() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM webhook_emit(NEW.workspace_id,'contact.tagged','contact',NEW.contact_id,jsonb_build_object('tag_id',NEW.tag_id));
  RETURN NEW;
 END IF;
 PERFORM webhook_emit(OLD.workspace_id,'contact.untagged','contact',OLD.contact_id,jsonb_build_object('tag_id',OLD.tag_id));
 RETURN OLD;
END $$;
CREATE TRIGGER webhook_contact_tag AFTER INSERT OR DELETE ON contact_tags FOR EACH ROW EXECUTE FUNCTION webhook_contact_tag();

CREATE FUNCTION webhook_company_tag() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM webhook_emit(NEW.workspace_id,'company.tagged','company',NEW.company_id,jsonb_build_object('tag_id',NEW.tag_id));
  RETURN NEW;
 END IF;
 IF COALESCE(current_setting('relay.deleting_company',true),'') <> OLD.company_id THEN
  PERFORM webhook_emit(OLD.workspace_id,'company.untagged','company',OLD.company_id,jsonb_build_object('tag_id',OLD.tag_id));
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER webhook_company_tag AFTER INSERT OR DELETE ON company_tags FOR EACH ROW EXECUTE FUNCTION webhook_company_tag();
