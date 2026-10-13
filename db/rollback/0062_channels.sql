-- Rollback for 0062_channels: the flag goes off, so nothing more is received or queued on other
-- channels, and deliveries not yet sent end as failed (nothing is sent after a rollback). Channel
-- office hours stop applying (their assignments go). Identities, threads, delivery history and the
-- suppression list are kept, so a re-deploy still never sends to a suppressed address.
UPDATE workspace_features SET enabled=false WHERE name='channels_v1';
UPDATE channel_deliveries SET status='failed',error='Stopped by rollback.',updated_at=now() WHERE status='queued';
DELETE FROM calendar_assignments WHERE scope='channel';
