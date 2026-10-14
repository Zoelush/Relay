-- Rollback for 0067_sms: the flag goes off, so the webhook refuses and nothing is texted. SMS
-- deliveries not yet sent fail, and webhook calls not yet read fail. The account, numbers,
-- consents, prices and the suppression list (opt-outs included) stay.
UPDATE workspace_features SET enabled=false WHERE name='channel_sms_v1';
UPDATE channel_deliveries SET status='failed',error='Stopped by rollback.' WHERE channel='sms' AND status IN ('queued','held');
UPDATE sms_inbound SET status='failed',error='Stopped by rollback.',read_at=now() WHERE status='received';
