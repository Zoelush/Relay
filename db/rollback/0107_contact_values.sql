-- Rollback for 0107_contact_values: the earlier code reads and writes contacts.profile, which the one
-- writer kept in step with the typed values throughout this step, so nothing is lost. The definitions
-- the backfill made stay, as ordinary contact attributes.
DROP FUNCTION relay_backfill_contact_values();
DROP TABLE contact_attribute_values;
DROP INDEX attribute_definitions_key;
