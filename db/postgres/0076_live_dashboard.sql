-- The live dashboard (phase 14, step R4; docs/REPORTING_STEP4.md): what's happening now, read from
-- the inbox's own tables but only from the conversations still in play. Additive: two partial
-- indexes over the live set (open or snoozed, customer-facing, not merged), so the dashboard's
-- queries read current conversations and never the history (tests/live.test.ts checks the plans).
CREATE INDEX conversations_live ON conversations(workspace_id,team_id,assigned)
 WHERE status IN ('open','snoozed') AND merged_into_id IS NULL AND visibility='customer';
-- Who has waited longest: open conversations in the order their customer has been waiting.
CREATE INDEX conversations_live_waiting ON conversations(workspace_id,(COALESCE(last_contact_reply_at,created_at)))
 WHERE status='open' AND merged_into_id IS NULL AND visibility='customer';
