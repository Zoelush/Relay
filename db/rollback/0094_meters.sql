-- Rollback for 0094_meters: the meters' indexes go (the earlier code doesn't read meters).
DROP INDEX IF EXISTS channel_deliveries_meter;
DROP INDEX IF EXISTS voice_calls_meter;
DROP INDEX IF EXISTS outbound_entries_meter;
DROP INDEX IF EXISTS ai_connector_calls_meter;
