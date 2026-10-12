-- Rollback for 0053_zoe_monitors: the flag goes off everywhere, stopping checks and hiding the
-- pages. The previous version lists only notifications with a conversation but counts every
-- unread one, so incident notifications are marked read rather than leaving a badge nobody can
-- clear. Tables, incidents and the nullable notification columns stay (additive).
UPDATE workspace_features SET enabled=false WHERE name='zoe_monitors_v1';
UPDATE notifications SET read_at=now() WHERE kind='zoe_incident' AND read_at IS NULL;
