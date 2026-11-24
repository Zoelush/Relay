-- Finishing phase 01, P1a (docs/PEOPLE_STEP1.md): a contact's custom data as typed values, stored
-- apart from their definitions and indexed per type, so segments can filter on them at scale.
-- Additive.
--
-- A contact or company attribute's name is its key in the API and the messenger, so it is unique
-- per workspace and model, whatever its case.
CREATE UNIQUE INDEX attribute_definitions_key ON attribute_definitions(workspace_id,owner_type,lower(name)) WHERE owner_type IN ('contact','company');

-- One row per contact and attribute. Exactly one of the typed columns holds the value, chosen by
-- the definition's type: text for string and options, number for integer and float, then boolean
-- and date. A value set to nothing is no row.
CREATE TABLE contact_attribute_values (
 workspace_id text NOT NULL, contact_id text NOT NULL, attribute_id text NOT NULL,
 text_value text CHECK(length(text_value)<=255),
 number_value numeric,
 bool_value boolean,
 date_value timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(text_value,number_value,bool_value,date_value)=1),
 PRIMARY KEY(workspace_id,contact_id,attribute_id),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id),
 FOREIGN KEY(workspace_id,attribute_id) REFERENCES attribute_definitions(workspace_id,id));
-- Indexed per type, for segments: an attribute's contacts with a given value, or in a range.
CREATE INDEX contact_values_text ON contact_attribute_values(workspace_id,attribute_id,lower(text_value)) WHERE text_value IS NOT NULL;
CREATE INDEX contact_values_number ON contact_attribute_values(workspace_id,attribute_id,number_value) WHERE number_value IS NOT NULL;
CREATE INDEX contact_values_bool ON contact_attribute_values(workspace_id,attribute_id,bool_value) WHERE bool_value IS NOT NULL;
CREATE INDEX contact_values_date ON contact_attribute_values(workspace_id,attribute_id,date_value) WHERE date_value IS NOT NULL;
ALTER TABLE contact_attribute_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_attribute_values FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON contact_attribute_values USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- What was in contacts.profile, moved: every key becomes a defined attribute, its type inferred
-- from the values it holds (all booleans, all whole numbers, all numbers, otherwise text), and
-- every value is copied into its typed column. Keys differing only in case become one attribute.
-- Kept as a function so it can be run again, and so a test can prove it on data written the old way.
CREATE FUNCTION relay_backfill_contact_values() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type)
 SELECT kv.workspace_id, gen_random_uuid()::text, min(kv.key), 'contact',
  CASE WHEN bool_and(jsonb_typeof(kv.value)='boolean') THEN 'boolean'
       WHEN bool_and(jsonb_typeof(kv.value)='number' AND CASE WHEN jsonb_typeof(kv.value)='number' THEN (kv.value#>>'{}')::numeric=trunc((kv.value#>>'{}')::numeric) ELSE false END) THEN 'integer'
       WHEN bool_and(jsonb_typeof(kv.value)='number') THEN 'float'
       ELSE 'string' END
 FROM (SELECT c.workspace_id, e.key, e.value FROM contacts c,
        jsonb_each(CASE WHEN jsonb_typeof(c.profile)='object' THEN c.profile ELSE '{}'::jsonb END) e
       WHERE jsonb_typeof(e.value) IN ('string','number','boolean')) kv
 WHERE NOT EXISTS (SELECT 1 FROM attribute_definitions d WHERE d.workspace_id=kv.workspace_id AND d.owner_type='contact' AND lower(d.name)=lower(kv.key))
 GROUP BY kv.workspace_id, lower(kv.key);

 INSERT INTO contact_attribute_values(workspace_id,contact_id,attribute_id,text_value,number_value,bool_value,date_value)
 SELECT * FROM (
  SELECT c.workspace_id, c.id, d.id,
   CASE WHEN d.value_type IN ('string','options') THEN left(e.value#>>'{}',255) END,
   CASE WHEN d.value_type IN ('integer','float') AND jsonb_typeof(e.value)='number' THEN (e.value#>>'{}')::numeric END,
   CASE WHEN d.value_type='boolean' AND jsonb_typeof(e.value)='boolean' THEN (e.value#>>'{}')::boolean END,
   CASE WHEN d.value_type='date' AND (e.value#>>'{}') ~ '^\d{4}-\d{2}-\d{2}' THEN (e.value#>>'{}')::timestamptz END
  FROM contacts c,
   jsonb_each(CASE WHEN jsonb_typeof(c.profile)='object' THEN c.profile ELSE '{}'::jsonb END) e
   JOIN attribute_definitions d ON d.owner_type='contact' AND lower(d.name)=lower(e.key) AND d.archived_at IS NULL
  WHERE d.workspace_id=c.workspace_id AND jsonb_typeof(e.value) IN ('string','number','boolean')
 ) v(workspace_id,contact_id,attribute_id,t,n,b,dt)
 WHERE num_nonnulls(t,n,b,dt)=1
 ON CONFLICT DO NOTHING;
END $$;
SELECT relay_backfill_contact_values();
