-- Rollback for 0035_inbox_status_sort: the new columns and the wider sort check stay (additive);
-- views saved with a sort the previous version doesn't know go back to newest. The count
-- functions go back to counting members only; the two new triggers go.
UPDATE inbox_views SET sort='newest' WHERE sort NOT IN ('newest','oldest','waiting','sla');
DROP TRIGGER IF EXISTS inbox_set_changed ON inbox_filter_members;
DROP TRIGGER IF EXISTS inbox_ticket_dirty ON tickets;
CREATE OR REPLACE FUNCTION relay_inbox_set_added() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE inbox_filter_sets s SET match_count=s.match_count+d.n,count_version=s.count_version+1
 FROM (SELECT workspace_id,set_id,count(*) AS n FROM added GROUP BY workspace_id,set_id) d
 WHERE s.workspace_id=d.workspace_id AND s.id=d.set_id;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION relay_inbox_set_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE inbox_filter_sets s SET match_count=s.match_count-d.n,count_version=s.count_version+1
 FROM (SELECT workspace_id,set_id,count(*) AS n FROM removed GROUP BY workspace_id,set_id) d
 WHERE s.workspace_id=d.workspace_id AND s.id=d.set_id;
 RETURN NULL;
END $$;
