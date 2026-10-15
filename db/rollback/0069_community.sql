-- Rollback for 0069_community: both flags go off, so Slack's webhook refuses, Discord's gateway
-- stops taking messages, and nothing is sent. Slack and Discord deliveries not yet sent fail, and
-- events not yet read fail. Connections and conversations stay.
UPDATE workspace_features SET enabled=false WHERE name IN ('channel_slack_v1','channel_discord_v1');
UPDATE channel_deliveries SET status='failed',error='Stopped by rollback.' WHERE channel IN ('slack','discord') AND status IN ('queued','held');
UPDATE community_inbound SET status='failed',error='Stopped by rollback.',read_at=now() WHERE status='received';
