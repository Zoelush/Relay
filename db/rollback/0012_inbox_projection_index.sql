-- Data-preserving rollback: retain this compatible additive index.
-- Roll back the application version if needed. Removing the index provides
-- no correctness benefit and reintroduces the measured scan bottleneck.
SELECT 1;
