-- Rollback for 0063_email_in: the flag goes off, so inbound addresses refuse mail, and emails
-- received but not yet read end as failed (their raw bytes are removed by storage lifecycle).
-- Conversations, their email messages and the settings stay, so a re-deploy picks up where it was.
UPDATE workspace_features SET enabled=false WHERE name='channel_email_v1';
UPDATE email_inbound SET status='failed',error='Stopped by rollback.' WHERE status='received';
