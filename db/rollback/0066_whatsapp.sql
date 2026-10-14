-- Rollback for 0066_whatsapp: the flag goes off, so the webhook refuses and nothing is sent.
-- WhatsApp deliveries not yet sent fail, and webhook calls not yet read fail. Numbers, templates,
-- opt-ins, conversations and the suppression list stay, so a re-deploy picks up where it was.
UPDATE workspace_features SET enabled=false WHERE name='channel_whatsapp_v1';
UPDATE channel_deliveries SET status='failed',error='Stopped by rollback.' WHERE channel='whatsapp' AND status IN ('queued','held');
UPDATE whatsapp_inbound SET status='failed',error='Stopped by rollback.',read_at=now() WHERE status='received';
