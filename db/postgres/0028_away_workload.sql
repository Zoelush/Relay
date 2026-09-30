-- Away mode and workload (phase 06, step B). When a teammate returns from away, automatic
-- assignment to them is paced (at most 3 per rolling 5 minutes for 30 minutes). A team may
-- return a member's open conversations to its inbox when they go away, and has a shared view
-- that is its inbox. Additive.
ALTER TABLE teammates ADD COLUMN presence_changed_at timestamptz;
ALTER TABLE teammates ADD COLUMN returned_at timestamptz;
ALTER TABLE teams ADD COLUMN unassign_on_away boolean NOT NULL DEFAULT false;
ALTER TABLE teams ADD COLUMN view_id text;
