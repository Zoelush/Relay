-- Rollback for 0096_usage_alerts: every workspace's thresholds cleared, so no usage alert is sent
-- (the earlier code sends none anyway). Sent alerts, their notifications and the columns stay.
UPDATE usage_settings SET alert_thresholds='{}' WHERE alert_thresholds<>'{}';
