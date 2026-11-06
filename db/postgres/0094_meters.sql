-- Meters (phase 16, step C9a; docs/SECURITY_STEP16.md). Additive: indexes only.
-- Each meter is read from its source record for a billing period (server/meters.ts), never
-- counted; these let a period's units be found without reading every row.
CREATE INDEX IF NOT EXISTS channel_deliveries_meter ON channel_deliveries(workspace_id,channel,created_at) WHERE status IN ('sent','delivered','read');
CREATE INDEX IF NOT EXISTS voice_calls_meter ON voice_calls(workspace_id,started_at) WHERE status='completed';
CREATE INDEX IF NOT EXISTS outbound_entries_meter ON outbound_entries(workspace_id,(COALESCE(entered_at,created_at))) WHERE status='sent';
CREATE INDEX IF NOT EXISTS ai_connector_calls_meter ON ai_connector_calls(workspace_id,created_at) WHERE result='ok';
