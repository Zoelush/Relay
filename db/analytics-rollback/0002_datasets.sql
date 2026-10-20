-- Rollback for the analytical store's 0002_datasets: its copies are rebuilt from the beginning (the
-- tables stay, and fill again on the next projection).
UPDATE a_sources SET watermark='-infinity';
UPDATE a_projection SET watermark='-infinity';
