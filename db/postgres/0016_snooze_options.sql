-- Snooze options. Additive: the timezone a snooze was resolved in (for display and audit)
-- and whether waking unassigns the conversation. Both reset on any state transition, so a
-- replaced or cancelled snooze can never unassign on a stale timer.
ALTER TABLE conversations ADD COLUMN snooze_unassign boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN snooze_timezone text;
