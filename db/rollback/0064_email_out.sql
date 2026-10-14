-- Rollback for 0064_email_out, with E2's code back: email deliveries not yet sent (queued or
-- waiting on the rate limit) end as failed, so nothing goes out after it, and E2's code sends no
-- away emails. Domains, reply addresses, reports, away settings and the suppression list stay, so
-- a re-deploy never sends to a suppressed address and replies to earlier emails still find their
-- conversation.
UPDATE channel_deliveries SET status='failed',error='Stopped by rollback.',not_before=NULL WHERE channel='email' AND status='queued';
