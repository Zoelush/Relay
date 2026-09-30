-- Rollback for 0023_ticket_links: additive, so nothing is dropped. The previous version ignores
-- `conversations.visibility`; internal ticket conversations have no customer identity, so no
-- messenger can list or open them either way. Queued broadcast jobs have no handler on the
-- previous version and reach the dead-letter queue, leaving unsent items untouched.
UPDATE workspace_features SET enabled=false WHERE name='tickets_v1';
