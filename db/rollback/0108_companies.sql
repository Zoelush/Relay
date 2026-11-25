-- Rollback for 0108_companies: the earlier code has no companies, so they go, with their
-- memberships, values and the messenger setting. Company attribute definitions stay, archived in
-- effect, since nothing reads them. Run only if no company data needs keeping.
DROP TRIGGER webhook_contact_company ON contact_companies;
DROP FUNCTION webhook_contact_company();
DROP TRIGGER webhook_company ON companies;
DROP FUNCTION webhook_company();
DROP TABLE people_settings;
DROP TABLE contact_companies;
DROP TABLE company_attribute_values;
DROP TABLE companies;
