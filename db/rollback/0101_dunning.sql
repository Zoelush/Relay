-- Rollback for 0101_dunning: no retries and no pausing for an unpaid invoice. Nothing a workspace
-- uses switches off: every "unpaid" invoice goes back to a plain failed one, so automated sending
-- runs again, and no further attempt is scheduled. The invoices, their history and what managers
-- were told stay as the record; the earlier code never reads these columns.
UPDATE invoices SET dunning='none', next_attempt_at=NULL, unpaid_at=NULL, retries=0 WHERE dunning <> 'none';
