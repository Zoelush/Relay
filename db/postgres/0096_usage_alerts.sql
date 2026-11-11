-- Usage alerts (phase 16, step C9c; docs/SECURITY_STEP18.md). Additive.
-- Thresholds (a percentage of each meter's limit and of the spend cap), the ledger of alerts sent
-- (once per meter or cap, threshold and billing period), and their notifications and emails.

ALTER TABLE usage_settings ADD COLUMN alert_thresholds integer[] NOT NULL DEFAULT '{80,100}'
  CHECK(cardinality(alert_thresholds) <= 5 AND 1 <= ALL(alert_thresholds) AND 100 >= ALL(alert_thresholds));

CREATE TABLE usage_alerts (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 subject text NOT NULL CHECK(subject IN ('ai_resolutions','emails','whatsapp','sms_segments','phone_minutes','outbound_chats','outbound_banners','connector_calls','spend_cap')),
 threshold integer NOT NULL CHECK(threshold BETWEEN 1 AND 100),
 period_start timestamptz NOT NULL,
 used numeric NOT NULL, of numeric NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,subject,threshold,period_start));
ALTER TABLE usage_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON usage_alerts USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

ALTER TABLE notifications ADD COLUMN usage_alert_id text;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('mention','zoe_incident','workflow_alert','webhook_disabled','usage_alert'));
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_fields;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_fields CHECK(
 CASE kind
  WHEN 'mention' THEN conversation_id IS NOT NULL AND part_id IS NOT NULL AND actor_teammate_id IS NOT NULL AND incident_id IS NULL AND workflow_alert_id IS NULL AND webhook_subscription_id IS NULL AND usage_alert_id IS NULL
  WHEN 'zoe_incident' THEN incident_id IS NOT NULL AND conversation_id IS NULL AND part_id IS NULL AND workflow_alert_id IS NULL AND webhook_subscription_id IS NULL AND usage_alert_id IS NULL
  WHEN 'workflow_alert' THEN workflow_alert_id IS NOT NULL AND incident_id IS NULL AND conversation_id IS NULL AND part_id IS NULL AND webhook_subscription_id IS NULL AND usage_alert_id IS NULL
  WHEN 'webhook_disabled' THEN webhook_subscription_id IS NOT NULL AND incident_id IS NULL AND conversation_id IS NULL AND part_id IS NULL AND workflow_alert_id IS NULL AND usage_alert_id IS NULL
  ELSE usage_alert_id IS NOT NULL AND webhook_subscription_id IS NULL AND incident_id IS NULL AND conversation_id IS NULL AND part_id IS NULL AND workflow_alert_id IS NULL END);
CREATE UNIQUE INDEX notifications_usage_alert ON notifications(workspace_id,teammate_id,usage_alert_id) WHERE usage_alert_id IS NOT NULL;

ALTER TABLE email_alerts ADD COLUMN usage_alert_id text;
ALTER TABLE email_alerts DROP CONSTRAINT email_alerts_kind_check;
ALTER TABLE email_alerts ADD CONSTRAINT email_alerts_kind_check CHECK(kind IN ('incident','webhook_disabled','invitation','usage'));
ALTER TABLE email_alerts DROP CONSTRAINT email_alerts_kind_fields;
ALTER TABLE email_alerts ADD CONSTRAINT email_alerts_kind_fields CHECK((kind='incident') = (incident_id IS NOT NULL) AND (kind='webhook_disabled') = (webhook_subscription_id IS NOT NULL) AND (kind='invitation') = (invitation_id IS NOT NULL) AND (kind='usage') = (usage_alert_id IS NOT NULL));
