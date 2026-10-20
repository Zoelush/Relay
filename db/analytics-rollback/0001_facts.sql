-- Rollback for the analytical store's 0001_facts: nothing is removed (the application's flag stops
-- the projection). Its tables can be rebuilt from the application at any time: the projection
-- starts again from the beginning when its watermark is cleared.
UPDATE a_projection SET watermark='-infinity',changes_watermark='-infinity',projected_at=NULL;
