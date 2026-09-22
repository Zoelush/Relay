-- Message writes and merge projections read all teammate rows for one conversation.
-- The existing primary key starts with teammate_id and cannot serve that lookup.
CREATE INDEX conversation_unread_by_conversation
 ON conversation_unread(workspace_id,conversation_id,teammate_id);
