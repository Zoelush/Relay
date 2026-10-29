-- Rollback for 0090_links_merges: both merge switches off, so merges across people and of leads by
-- email are refused as before (merges already made stay, and can be reversed as before). Link
-- policies stay: the earlier code doesn't read them. The tables, columns and audit records stay.
UPDATE security_settings SET merge_across_people=false,merge_leads_by_email=false WHERE merge_across_people OR merge_leads_by_email;
