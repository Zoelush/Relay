-- Seats (phase 16, step C8b; docs/SECURITY_STEP15.md). Additive.
-- The seat ledger: every teammate's joining and seat change, written by the database in the change's
-- own transaction, append-only (proration is computed from it, never counted). Each workspace's
-- billing period runs monthly from its anchor (C10's subscriptions will own it).

ALTER TABLE workspace_plans ADD COLUMN period_anchor timestamptz NOT NULL DEFAULT now();

CREATE TABLE seat_changes (
 workspace_id text NOT NULL REFERENCES workspace(id),
 seq bigint GENERATED ALWAYS AS IDENTITY,
 teammate_id text NOT NULL, teammate_name text NOT NULL DEFAULT '',
 from_seat text CHECK(from_seat IN ('full','limited')), to_seat text NOT NULL CHECK(to_seat IN ('full','limited')),
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id text, actor_name text,
 PRIMARY KEY(workspace_id,seq));
CREATE INDEX seat_changes_at ON seat_changes(workspace_id,at);
ALTER TABLE seat_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE seat_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON seat_changes USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

CREATE FUNCTION record_seat_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.seat IS NOT DISTINCT FROM OLD.seat THEN RETURN NEW; END IF;
  INSERT INTO seat_changes(workspace_id,teammate_id,teammate_name,from_seat,to_seat,actor_id,actor_name)
  VALUES(NEW.workspace_id,NEW.id,NEW.name,CASE WHEN TG_OP='UPDATE' THEN OLD.seat END,NEW.seat,
         NULLIF(current_setting('relay.actor_id',true),''),NULLIF(current_setting('relay.actor_name',true),''));
  RETURN NEW;
END $$;
CREATE TRIGGER seat_change AFTER INSERT OR UPDATE OF seat ON teammates FOR EACH ROW EXECUTE FUNCTION record_seat_change();

CREATE FUNCTION seat_changes_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'seat_changes is append-only'; END $$;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON seat_changes FOR EACH ROW EXECUTE FUNCTION seat_changes_append_only();

-- Teammates already here: their seat as at the start of the current period.
INSERT INTO seat_changes(workspace_id,teammate_id,teammate_name,from_seat,to_seat,at)
SELECT t.workspace_id,t.id,t.name,NULL,t.seat,p.period_anchor FROM teammates t JOIN workspace_plans p ON p.workspace_id=t.workspace_id;
