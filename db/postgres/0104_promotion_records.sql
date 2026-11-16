-- The paired test workspace, T2b (docs/TEST_WORKSPACE_STEP4.md): the messenger and a help centre's
-- look are promotable too, and the images they refer to come with them. The ledger needs two more
-- things to say. "action" tells a promotion from a look put back again, because a help centre's
-- look has no published versions of its own: the row that promoted it holds the look it replaced,
-- in "previous", and putting that look back appends a row of its own rather than altering history.
-- "brought" lists the images copied into this workspace with the promotion, each with what it is
-- for, so the ledger can say what arrived beyond the configuration itself. Additive.
ALTER TABLE promotions ADD COLUMN action text NOT NULL DEFAULT 'promoted'
 CHECK(action IN ('promoted','reverted'));
ALTER TABLE promotions ADD COLUMN brought jsonb NOT NULL DEFAULT '[]'::jsonb;
