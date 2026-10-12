-- Rollback for 0052_zoe_review: the flag goes off everywhere, hiding the review queue and
-- stopping sampling. The tables and the sample size stay (additive); the previous version never
-- reads them, and ratings and content gaps are kept for when the step is deployed again.
UPDATE workspace_features SET enabled=false WHERE name='zoe_review_v1';
