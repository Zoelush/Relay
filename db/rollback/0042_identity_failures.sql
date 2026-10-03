-- Rollback for 0042_identity_failures: the table stays (additive) and the previous version neither
-- writes nor reads it. Its rows hold only reasons and counts, and are emptied here.
DELETE FROM identity_failures;
