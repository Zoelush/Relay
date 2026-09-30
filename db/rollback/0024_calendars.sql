-- Rollback for 0024_calendars: additive, so nothing is dropped. The previous version reads
-- calendars only through brand settings (calendarId/calendarVersion) and business_calendars,
-- which are unchanged; names and assignments are simply unused. Turning `sla_v1` off hides
-- the calendar routes.
UPDATE workspace_features SET enabled=false WHERE name='sla_v1';
