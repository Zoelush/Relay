-- Data-preserving rollback: keep the drafts table. The previous application version neither
-- reads nor writes it; drafts reappear if this version is redeployed within 30 days.
SELECT 1;
