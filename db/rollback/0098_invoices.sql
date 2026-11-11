-- Rollback for 0098_invoices: the page's flag is turned off everywhere, so no invoice is issued or
-- charged and the earlier code never reads these tables. Issued invoices, their lines and units,
-- billing details and cards on file stay as the record (an invoice is never deleted).
UPDATE workspace_features SET enabled=false WHERE name='billing_v1' AND enabled;
