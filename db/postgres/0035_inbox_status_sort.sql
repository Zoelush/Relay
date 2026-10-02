-- Phase 04 follow-up: the conversation list's status picker and sorts. View members carry the
-- conversation's status, its ticket state kind, last activity, priority and snooze time, so a
-- status filter and every sort stay one index range; each set also keeps its open count, shown
-- next to views once the built-in views stop filtering to open themselves. Additive.
ALTER TABLE inbox_filter_members ADD COLUMN status text;
ALTER TABLE inbox_filter_members ADD COLUMN ticket_kind text;
ALTER TABLE inbox_filter_members ADD COLUMN activity_at timestamptz;
ALTER TABLE inbox_filter_members ADD COLUMN priority boolean NOT NULL DEFAULT false;
ALTER TABLE inbox_filter_members ADD COLUMN snooze_until timestamptz;
-- Saved views may keep the new sorts. ("sla" was accepted by the server but not here: fixed.)
ALTER TABLE inbox_views DROP CONSTRAINT inbox_views_sort_check;
ALTER TABLE inbox_views ADD CONSTRAINT inbox_views_sort_check CHECK(sort IN ('newest','oldest','waiting','sla','activity','created','priority','snoozed'));
ALTER TABLE inbox_filter_sets ADD COLUMN open_count bigint NOT NULL DEFAULT 0 CHECK(open_count>=0);

UPDATE inbox_filter_members m SET status=c.status,
 activity_at=COALESCE(GREATEST(c.last_contact_reply_at,c.last_teammate_reply_at),c.created_at),
 priority=c.priority, snooze_until=c.snooze_until,
 ticket_kind=(SELECT s.kind FROM tickets k JOIN ticket_states s ON s.workspace_id=k.workspace_id AND s.type_id=k.type_id AND s.id=k.state_id
   WHERE k.workspace_id=c.workspace_id AND k.conversation_id=c.id)
FROM conversations c WHERE c.workspace_id=m.workspace_id AND c.id=m.conversation_id;
UPDATE inbox_filter_sets s SET open_count=(SELECT count(*) FROM inbox_filter_members m WHERE m.workspace_id=s.workspace_id AND m.set_id=s.id AND m.status='open');

CREATE INDEX inbox_filter_status ON inbox_filter_members(workspace_id,set_id,status);
CREATE INDEX inbox_filter_ticket_kind ON inbox_filter_members(workspace_id,set_id,ticket_kind) WHERE ticket_kind IS NOT NULL;
CREATE INDEX inbox_filter_activity ON inbox_filter_members(workspace_id,set_id,activity_at,conversation_id);
CREATE INDEX inbox_filter_priority ON inbox_filter_members(workspace_id,set_id,priority,activity_at,conversation_id);
CREATE INDEX inbox_filter_snoozed ON inbox_filter_members(workspace_id,set_id,snooze_until,conversation_id);

-- Open counts, one update per set per statement (as match_count).
CREATE OR REPLACE FUNCTION relay_inbox_set_added() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE inbox_filter_sets s SET match_count=s.match_count+d.n,open_count=s.open_count+d.o,count_version=s.count_version+1
 FROM (SELECT workspace_id,set_id,count(*) AS n,count(*) FILTER (WHERE status='open') AS o FROM added GROUP BY workspace_id,set_id) d
 WHERE s.workspace_id=d.workspace_id AND s.id=d.set_id;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION relay_inbox_set_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE inbox_filter_sets s SET match_count=s.match_count-d.n,open_count=s.open_count-d.o,count_version=s.count_version+1
 FROM (SELECT workspace_id,set_id,count(*) AS n,count(*) FILTER (WHERE status='open') AS o FROM removed GROUP BY workspace_id,set_id) d
 WHERE s.workspace_id=d.workspace_id AND s.id=d.set_id;
 RETURN NULL;
END $$;
CREATE FUNCTION relay_inbox_set_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE inbox_filter_sets s SET open_count=s.open_count+d.o,count_version=s.count_version+1
 FROM (SELECT workspace_id,set_id,sum(o) AS o FROM (
   SELECT workspace_id,set_id,CASE WHEN status='open' THEN 1 ELSE 0 END AS o FROM after
   UNION ALL SELECT workspace_id,set_id,CASE WHEN status='open' THEN -1 ELSE 0 END FROM before) x
   GROUP BY workspace_id,set_id HAVING sum(o)<>0) d
 WHERE s.workspace_id=d.workspace_id AND s.id=d.set_id;
 RETURN NULL;
END $$;
CREATE TRIGGER inbox_set_changed AFTER UPDATE ON inbox_filter_members
 REFERENCING OLD TABLE AS before NEW TABLE AS after FOR EACH STATEMENT EXECUTE FUNCTION relay_inbox_set_changed();

-- A ticket's state moving (or a ticket appearing) re-projects its conversation.
CREATE TRIGGER inbox_ticket_dirty AFTER INSERT OR UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION relay_inbox_dirty();
