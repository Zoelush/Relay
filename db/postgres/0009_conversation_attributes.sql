CREATE TABLE conversation_attribute_values (
 workspace_id text NOT NULL,conversation_id text NOT NULL,attribute_id text NOT NULL,
 string_value text,integer_value bigint,float_value double precision,boolean_value boolean,date_value date,option_values text[],
 origin_timezone text,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,conversation_id,attribute_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,attribute_id) REFERENCES attribute_definitions(workspace_id,id),
 CHECK(num_nonnulls(string_value,integer_value,float_value,boolean_value,date_value,option_values)=1)
);
CREATE INDEX conversation_attribute_string ON conversation_attribute_values(workspace_id,attribute_id,string_value,conversation_id) WHERE string_value IS NOT NULL;
CREATE INDEX conversation_attribute_integer ON conversation_attribute_values(workspace_id,attribute_id,integer_value,conversation_id) WHERE integer_value IS NOT NULL;
CREATE INDEX conversation_attribute_float ON conversation_attribute_values(workspace_id,attribute_id,float_value,conversation_id) WHERE float_value IS NOT NULL;
CREATE INDEX conversation_attribute_boolean ON conversation_attribute_values(workspace_id,attribute_id,boolean_value,conversation_id) WHERE boolean_value IS NOT NULL;
CREATE INDEX conversation_attribute_date ON conversation_attribute_values(workspace_id,attribute_id,date_value,conversation_id) WHERE date_value IS NOT NULL;
CREATE INDEX conversation_attribute_options ON conversation_attribute_values USING gin(option_values);
ALTER TABLE conversation_attribute_values ENABLE ROW LEVEL SECURITY;ALTER TABLE conversation_attribute_values FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON conversation_attribute_values USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE FUNCTION keep_attribute_definitions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Attribute definitions must be archived, never deleted'; END $$;
CREATE TRIGGER archive_only_attributes BEFORE DELETE ON attribute_definitions FOR EACH ROW EXECUTE FUNCTION keep_attribute_definitions();
CREATE TRIGGER immutable_business_calendars BEFORE UPDATE OR DELETE ON business_calendars FOR EACH ROW EXECUTE FUNCTION reject_part_mutation();
