-- Rollback for 0022_tickets: additive, so nothing is dropped. The previous version never
-- reads the ticket tables; turning `tickets_v1` off hides tickets, and ticket values remain as
-- ordinary conversation attributes. Ticket events stay on timelines as system events.
UPDATE workspace_features SET enabled=false WHERE name='tickets_v1';
