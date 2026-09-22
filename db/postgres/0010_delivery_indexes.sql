CREATE INDEX conversation_alias_reverse ON conversations(workspace_id,merged_into_id,id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX identity_contact_reverse ON identity_contact_mappings(workspace_id,contact_id,identity_id);
CREATE INDEX conversation_participant_identity ON conversation_participants(workspace_id,identity_id,conversation_id);
