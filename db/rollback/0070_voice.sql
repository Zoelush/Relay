-- Rollback for 0070_voice: the flag goes off, so calls to Relay's numbers are told it's unavailable
-- and hung up, and nothing is recorded. Calls in progress are marked failed, and recordings not yet
-- read fail. Settings, calls, transcripts and conversations stay.
UPDATE workspace_features SET enabled=false WHERE name='channel_voice_v1';
UPDATE voice_calls SET status='failed',ended_at=now() WHERE status='in_progress';
UPDATE voice_inbound SET status='failed',error='Stopped by rollback.',read_at=now() WHERE status='received';
