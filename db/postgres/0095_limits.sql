-- Limits and the spend cap (phase 16, step C9b; docs/SECURITY_STEP17.md). Additive.
-- Each meter's limit in units per billing period (none by default), the workspace's spend cap on
-- metered usage, and the mark on automated channel messages held by a limit until it's lifted
-- or the period ends (deferred with not_before, released by the sweep as before).

CREATE TABLE usage_limits (
 workspace_id text NOT NULL REFERENCES workspace(id),
 meter text NOT NULL CHECK(meter IN ('ai_resolutions','emails','whatsapp','sms_segments','phone_minutes','outbound_chats','outbound_banners','connector_calls')),
 units integer NOT NULL CHECK(units BETWEEN 1 AND 100000000),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,meter));
ALTER TABLE usage_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON usage_limits USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF units ON usage_limits FOR EACH ROW EXECUTE FUNCTION audit_row('usage_limit','usage_limit','meter','meter');

CREATE TABLE usage_settings (
 workspace_id text PRIMARY KEY REFERENCES workspace(id),
 spend_cap_cents integer CHECK(spend_cap_cents IS NULL OR spend_cap_cents BETWEEN 100 AND 1000000000),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE usage_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON usage_settings USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE TRIGGER audit AFTER INSERT OR UPDATE OF spend_cap_cents ON usage_settings FOR EACH ROW EXECUTE FUNCTION audit_row('spend_cap','workspace','workspace_id','');

ALTER TABLE channel_deliveries ADD COLUMN limit_held boolean NOT NULL DEFAULT false;
CREATE INDEX channel_deliveries_limit_held ON channel_deliveries(workspace_id,channel) WHERE limit_held;
