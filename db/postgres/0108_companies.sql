-- Finishing phase 01, P1b (docs/PEOPLE_STEP2.md): companies, with their plan, seats, monthly spend
-- and typed attributes, and contacts in many companies with a role on each. Additive.
--
-- A company: `company_id` is the customer's own id for it (unique per workspace), the way the API
-- and the messenger's signed claim name it. Routing and reports will segment on plan, seats and
-- monthly spend, so they are columns of their own.
CREATE TABLE companies (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 company_id text NOT NULL CHECK(length(company_id) BETWEEN 1 AND 200),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
 plan text CHECK(length(plan)<=255),
 seats integer CHECK(seats>=0),
 monthly_spend numeric(14,2) CHECK(monthly_spend>=0),
 website text CHECK(length(website)<=2000),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,company_id));
CREATE INDEX companies_name ON companies(workspace_id,lower(name),id);
CREATE INDEX companies_plan ON companies(workspace_id,lower(plan)) WHERE plan IS NOT NULL;

-- A company's custom data, typed by its definitions (owner `company`), as P1a's contact values are.
CREATE TABLE company_attribute_values (
 workspace_id text NOT NULL, company_id text NOT NULL, attribute_id text NOT NULL,
 text_value text CHECK(length(text_value)<=255),
 number_value numeric,
 bool_value boolean,
 date_value timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(text_value,number_value,bool_value,date_value)=1),
 PRIMARY KEY(workspace_id,company_id,attribute_id),
 FOREIGN KEY(workspace_id,company_id) REFERENCES companies(workspace_id,id),
 FOREIGN KEY(workspace_id,attribute_id) REFERENCES attribute_definitions(workspace_id,id));
CREATE INDEX company_values_text ON company_attribute_values(workspace_id,attribute_id,lower(text_value)) WHERE text_value IS NOT NULL;
CREATE INDEX company_values_number ON company_attribute_values(workspace_id,attribute_id,number_value) WHERE number_value IS NOT NULL;
CREATE INDEX company_values_bool ON company_attribute_values(workspace_id,attribute_id,bool_value) WHERE bool_value IS NOT NULL;
CREATE INDEX company_values_date ON company_attribute_values(workspace_id,attribute_id,date_value) WHERE date_value IS NOT NULL;

-- A contact in a company, with their role there. `source` says who added it: the portal's company
-- visibility trusts a membership the messenger added only while the workspace allows that.
CREATE TABLE contact_companies (
 workspace_id text NOT NULL, contact_id text NOT NULL, company_id text NOT NULL,
 role text NOT NULL DEFAULT '' CHECK(length(role)<=100),
 source text NOT NULL CHECK(source IN ('api','inbox','messenger','merge')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,contact_id,company_id),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id),
 FOREIGN KEY(workspace_id,company_id) REFERENCES companies(workspace_id,id));
CREATE INDEX contact_companies_by_company ON contact_companies(workspace_id,company_id,contact_id);

-- How people data may be written. Off by default: nobody can claim a company from the messenger.
CREATE TABLE people_settings (
 workspace_id text PRIMARY KEY REFERENCES workspace(id),
 messenger_sets_companies boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by text);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['companies','company_attribute_values','contact_companies','people_settings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

-- The setting is a security decision, so its changes are in the audit log.
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON people_settings FOR EACH ROW EXECUTE FUNCTION audit_row('people_settings','workspace','workspace_id','');

-- Webhooks (as 0078): written by the database, in the same transaction as the change. A company's
-- writer bumps its version on every change, its custom data included. While a company is being
-- deleted (relay.deleting_company), its memberships go without a detached event each.
CREATE FUNCTION webhook_company() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM webhook_emit(NEW.workspace_id,'company.created','company',NEW.id,'{}');
 ELSIF TG_OP='DELETE' THEN
  PERFORM webhook_emit(OLD.workspace_id,'company.deleted','company',OLD.id,jsonb_build_object('company_id',OLD.company_id,'name',OLD.name));
  RETURN OLD;
 ELSIF NEW.version IS DISTINCT FROM OLD.version THEN
  PERFORM webhook_emit(NEW.workspace_id,'company.updated','company',NEW.id,'{}');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_company AFTER INSERT OR UPDATE OR DELETE ON companies FOR EACH ROW EXECUTE FUNCTION webhook_company();

CREATE FUNCTION webhook_contact_company() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM webhook_emit(NEW.workspace_id,'company.contact_attached','company',NEW.company_id,jsonb_build_object('contact_id',NEW.contact_id,'role',NEW.role));
  RETURN NEW;
 END IF;
 IF COALESCE(current_setting('relay.deleting_company',true),'') <> OLD.company_id THEN
  PERFORM webhook_emit(OLD.workspace_id,'company.contact_detached','company',OLD.company_id,jsonb_build_object('contact_id',OLD.contact_id));
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER webhook_contact_company AFTER INSERT OR DELETE ON contact_companies FOR EACH ROW EXECUTE FUNCTION webhook_contact_company();
