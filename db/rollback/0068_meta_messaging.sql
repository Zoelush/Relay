-- Rollback for 0068_meta_messaging: both flags go off, so the webhook refuses and nothing is sent.
-- Messenger and Instagram deliveries not yet sent fail, and webhook calls not yet read fail.
-- Pages, conversations and the suppression list stay.
UPDATE workspace_features SET enabled=false WHERE name IN ('channel_facebook_v1','channel_instagram_v1');
UPDATE channel_deliveries SET status='failed',error='Stopped by rollback.' WHERE channel IN ('facebook','instagram') AND status IN ('queued','held');
UPDATE meta_inbound SET status='failed',error='Stopped by rollback.',read_at=now() WHERE status='received';
