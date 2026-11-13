-- Rollback for 0103_promotions: nothing can be promoted any more, because the earlier code has no
-- way to. What was promoted stays in production as what it is — a published version like any other
-- — and the record of how it got there stays too, unread. The baselines stop being written.
-- Nothing is undone: a promotion that already happened is a published change, not a pending one.
SELECT 1;
