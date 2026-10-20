-- Rollback for 0072_outbound: the flag goes off, so nothing more is sent and the messenger asks for
-- nothing. Live messages are paused, and pending entries are kept as they are. Conversations
-- already started stay, with their ledger.
UPDATE workspace_features SET enabled=false WHERE name='outbound_v1';
UPDATE outbound_messages SET state='paused',updated_at=now() WHERE state='live';
