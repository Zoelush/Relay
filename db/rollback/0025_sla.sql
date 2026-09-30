-- Rollback for 0025_sla: additive, so nothing is dropped. The previous version never reads the
-- SLA tables or columns; views sorted by "sla" fall back to their saved default on read of an
-- unknown sort (refused, then the client's saved sort applies). Turning `sla_v1` off stops
-- clocks from being updated. Queued `sla.reevaluate` jobs reach the dead-letter queue.
UPDATE workspace_features SET enabled=false WHERE name='sla_v1';
