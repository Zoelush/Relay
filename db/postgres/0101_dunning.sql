-- Dunning (phase 16, step C10c; docs/SECURITY_STEP22.md). Additive.
-- A declined charge is tried again on day 1, 3 and 7. If none of them is paid, the workspace is
-- "unpaid": automated sending pauses exactly as the spend cap pauses it, and paying lifts it at
-- once. Billing managers are told at the first failure, before the last try, and when it runs out.

-- Where an invoice is in its retries. 'none' is every invoice that has never been declined.
ALTER TABLE invoices ADD COLUMN dunning text NOT NULL DEFAULT 'none' CHECK(dunning IN ('none','retrying','unpaid'));
ALTER TABLE invoices ADD COLUMN next_attempt_at timestamptz;
-- When the first charge was declined, and how many of the scheduled tries have been made (a
-- manager's own "Pay now" is not one of them, so trying by hand never spends the schedule).
ALTER TABLE invoices ADD COLUMN first_failed_at timestamptz;
ALTER TABLE invoices ADD COLUMN retries integer NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN unpaid_at timestamptz;
CREATE INDEX invoices_next_attempt ON invoices(workspace_id,next_attempt_at) WHERE next_attempt_at IS NOT NULL;

-- Each thing a manager is told, once: the invoice and which moment it was.
CREATE TABLE billing_alerts (
 workspace_id text NOT NULL REFERENCES workspace(id),
 id text NOT NULL,
 invoice_id text NOT NULL,
 stage text NOT NULL CHECK(stage IN ('failed','last_try','unpaid')),
 attempts integer NOT NULL DEFAULT 0,
 -- What the managers were told, kept so the email says exactly what the notification did.
 text text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,invoice_id,stage),
 FOREIGN KEY(workspace_id,invoice_id) REFERENCES invoices(workspace_id,id));
ALTER TABLE billing_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON billing_alerts USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- Told in the app, and by email, like a usage alert.
ALTER TABLE notifications ADD COLUMN billing_alert_id text;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('mention','zoe_incident','workflow_alert','webhook_disabled','usage_alert','billing_alert'));
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_fields;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_fields CHECK(
 CASE kind
  WHEN 'mention' THEN conversation_id IS NOT NULL AND part_id IS NOT NULL AND actor_teammate_id IS NOT NULL AND incident_id IS NULL AND workflow_alert_id IS NULL AND webhook_subscription_id IS NULL AND usage_alert_id IS NULL AND billing_alert_id IS NULL
  WHEN 'zoe_incident' THEN incident_id IS NOT NULL AND conversation_id IS NULL AND part_id IS NULL AND workflow_alert_id IS NULL AND webhook_subscription_id IS NULL AND usage_alert_id IS NULL AND billing_alert_id IS NULL
  WHEN 'workflow_alert' THEN workflow_alert_id IS NOT NULL AND incident_id IS NULL AND conversation_id IS NULL AND part_id IS NULL AND webhook_subscription_id IS NULL AND usage_alert_id IS NULL AND billing_alert_id IS NULL
  WHEN 'webhook_disabled' THEN webhook_subscription_id IS NOT NULL AND incident_id IS NULL AND conversation_id IS NULL AND part_id IS NULL AND workflow_alert_id IS NULL AND usage_alert_id IS NULL AND billing_alert_id IS NULL
  WHEN 'billing_alert' THEN billing_alert_id IS NOT NULL AND usage_alert_id IS NULL AND webhook_subscription_id IS NULL AND incident_id IS NULL AND conversation_id IS NULL AND part_id IS NULL AND workflow_alert_id IS NULL
  ELSE usage_alert_id IS NOT NULL AND billing_alert_id IS NULL AND webhook_subscription_id IS NULL AND incident_id IS NULL AND conversation_id IS NULL AND part_id IS NULL AND workflow_alert_id IS NULL END);
CREATE UNIQUE INDEX notifications_billing_alert ON notifications(workspace_id,teammate_id,billing_alert_id) WHERE billing_alert_id IS NOT NULL;

ALTER TABLE email_alerts ADD COLUMN billing_alert_id text;
ALTER TABLE email_alerts DROP CONSTRAINT email_alerts_kind_check;
ALTER TABLE email_alerts ADD CONSTRAINT email_alerts_kind_check CHECK(kind IN ('incident','webhook_disabled','invitation','usage','billing'));
ALTER TABLE email_alerts DROP CONSTRAINT email_alerts_kind_fields;
ALTER TABLE email_alerts ADD CONSTRAINT email_alerts_kind_fields CHECK((kind='incident') = (incident_id IS NOT NULL) AND (kind='webhook_disabled') = (webhook_subscription_id IS NOT NULL) AND (kind='invitation') = (invitation_id IS NOT NULL) AND (kind='usage') = (usage_alert_id IS NOT NULL) AND (kind='billing') = (billing_alert_id IS NOT NULL));
