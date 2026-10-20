-- Rollback for 0078_webhooks: the triggers stop writing events. The tables, deliveries and their
-- log stay, and turning `developer_api_v1` off stops delivery. Notifications and alert emails
-- already made stay valid.
DROP TRIGGER IF EXISTS webhook_part ON conversation_parts;
DROP TRIGGER IF EXISTS webhook_conversation ON conversations;
DROP TRIGGER IF EXISTS webhook_contact ON contacts;
DROP TRIGGER IF EXISTS webhook_contact_event ON contact_events;
DROP TRIGGER IF EXISTS webhook_ticket ON tickets;
DROP TRIGGER IF EXISTS webhook_resolution ON ai_resolutions;
DROP TRIGGER IF EXISTS webhook_revision ON knowledge_revisions;
