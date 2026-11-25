-- Rollback for 0109_people_tags: the earlier code has no tags on people, so these go. The tags
-- themselves stay, with their conversations. Run only if no tags on people need keeping.
DROP TRIGGER webhook_company_tag ON company_tags;
DROP FUNCTION webhook_company_tag();
DROP TRIGGER webhook_contact_tag ON contact_tags;
DROP FUNCTION webhook_contact_tag();
DROP TABLE company_tags;
DROP TABLE contact_tags;
