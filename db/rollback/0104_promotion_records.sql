-- Rollback for 0104_promotion_records: the earlier code promotes workflows and Zoe's guidance
-- only, and reads neither column. A messenger or a look already promoted stays as it is in
-- production, and the images that came with it stay too, as ordinary uploads of this workspace.
-- What is lost is the record of which images arrived and of any look put back again.
ALTER TABLE promotions DROP COLUMN brought;
ALTER TABLE promotions DROP COLUMN action;
