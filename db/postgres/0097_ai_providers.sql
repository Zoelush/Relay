-- AI providers (phase 16, step C9d; docs/SECURITY_STEP19.md). Additive.
-- A workspace's own AI providers for Zoe: one connection per provider (its key sealed with the
-- connector key, never returned), one of them primary and another the fallback. Each model call
-- records who served it and whose key; each answer and resolution records whose key, and
-- resolutions on the workspace's own key are their own meter.

CREATE TABLE ai_providers (
 workspace_id text NOT NULL REFERENCES workspace(id),
 provider text NOT NULL CHECK(provider IN ('anthropic','openai','gemini','deepseek','custom')),
 key_sealed text NOT NULL,
 key_hint text NOT NULL DEFAULT '',
 base_url text CHECK((provider='custom') = (base_url IS NOT NULL)),
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 128),
 classifier_model text CHECK(classifier_model IS NULL OR length(classifier_model) BETWEEN 1 AND 128),
 role text CHECK(role IN ('primary','fallback')),
 tested_at timestamptz, test_ok boolean, test_detail text NOT NULL DEFAULT '',
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,provider));
CREATE UNIQUE INDEX ai_providers_role ON ai_providers(workspace_id,role) WHERE role IS NOT NULL;
ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ai_providers USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
-- A test's result isn't a change anyone made: only the connection's own fields are audited (the
-- sealed key only as "a secret was replaced").
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF key_sealed,base_url,model,classifier_model,role ON ai_providers
 FOR EACH ROW EXECUTE FUNCTION audit_row('ai_provider','ai_provider','provider','provider');

-- Who served each call: the provider, whose key, and the primary that failed first (and why).
ALTER TABLE ai_model_calls ADD COLUMN provider text;
ALTER TABLE ai_model_calls ADD COLUMN key_source text NOT NULL DEFAULT 'relay' CHECK(key_source IN ('relay','workspace'));
ALTER TABLE ai_model_calls ADD COLUMN failover text;
-- Whose key answered each answer, and so each resolution (and its reversal).
ALTER TABLE ai_answers ADD COLUMN key_source text CHECK(key_source IN ('relay','workspace'));
ALTER TABLE ai_resolutions ADD COLUMN key_source text NOT NULL DEFAULT 'relay' CHECK(key_source IN ('relay','workspace'));

-- The new meter, in limits and alerts.
ALTER TABLE usage_limits DROP CONSTRAINT usage_limits_meter_check;
ALTER TABLE usage_limits ADD CONSTRAINT usage_limits_meter_check
 CHECK(meter IN ('ai_resolutions','ai_resolutions_own_key','emails','whatsapp','sms_segments','phone_minutes','outbound_chats','outbound_banners','connector_calls'));
ALTER TABLE usage_alerts DROP CONSTRAINT usage_alerts_subject_check;
ALTER TABLE usage_alerts ADD CONSTRAINT usage_alerts_subject_check
 CHECK(subject IN ('ai_resolutions','ai_resolutions_own_key','emails','whatsapp','sms_segments','phone_minutes','outbound_chats','outbound_banners','connector_calls','spend_cap'));

-- Settings › Knowledge & AI › AI providers is behind `ai_providers_v1`, off by default.
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'ai_providers_v1',false FROM workspace ON CONFLICT DO NOTHING;
