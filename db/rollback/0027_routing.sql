-- Rollback for 0027_routing: additive, so nothing is dropped. The previous version ignores the
-- new team and teammate columns; with `routing_v1` off nothing is assigned automatically and
-- conversations waiting in a team inbox stay there, visible and assignable by hand.
UPDATE workspace_features SET enabled=false WHERE name='routing_v1';
