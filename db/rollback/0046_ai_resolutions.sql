-- Rollback for 0046_ai_resolutions: the ledger stays, untouched (it is billing evidence and
-- append-only); the previous version neither reads nor writes it, nor the window column.
-- Conversations already marked resolved keep that AI state, which 0044 allows.
SELECT 1;
