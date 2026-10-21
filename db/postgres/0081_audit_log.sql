-- The audit log (phase 16, step C1; docs/SECURITY_STEP1.md). Additive.
-- Every administrative and sensitive action, written in the action's own transaction: by a
-- trigger on each administrative table (so no code path can skip it), and by `recordAudit` for
-- what isn't a row change (a customer record opened, an export asked for). Who acted comes from
-- the transaction (`relay.actor_*`, set by `authorize` and the API's token check), else "system".
-- Append-only: an update is refused, and a row is deleted only by retention's pruning.
CREATE TABLE audit_events (
 workspace_id text NOT NULL REFERENCES workspace(id),
 seq bigint GENERATED ALWAYS AS IDENTITY,
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 action text NOT NULL,
 actor_type text NOT NULL CHECK(actor_type IN ('teammate','system')),
 actor_id text, actor_name text,
 -- How a teammate acted when not in the app: `api_token:<id>` or `app:<installation id>`.
 via text,
 target_type text NOT NULL, target_id text, target_name text,
 details jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(workspace_id,seq));
CREATE INDEX audit_events_at ON audit_events(workspace_id,at DESC,seq DESC);
CREATE INDEX audit_events_action ON audit_events(workspace_id,action,at DESC);
CREATE INDEX audit_events_actor ON audit_events(workspace_id,actor_id,at DESC);
CREATE INDEX audit_events_target ON audit_events(workspace_id,target_type,target_id,at DESC);

-- How long the log is kept (at least 90 days, at most 7 years). Changing it is itself audited.
CREATE TABLE audit_settings (
 workspace_id text PRIMARY KEY REFERENCES workspace(id),
 retention_days int NOT NULL DEFAULT 365 CHECK(retention_days BETWEEN 90 AND 2555),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now());

-- Settings › Security (the audit log first) is behind `security_v1`, off by default. Recording isn't.
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'security_v1',false FROM workspace ON CONFLICT DO NOTHING;

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
-- Read and written only in its own workspace. (Migrations run as the database owner, outside
-- row-level security: a migration's own changes are recorded as the system.)
CREATE POLICY tenant ON audit_events USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
ALTER TABLE audit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON audit_settings USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

CREATE FUNCTION keep_audit_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' AND current_setting('relay.audit_prune',true) = 'on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'The audit log is append-only';
END $$;
CREATE TRIGGER immutable_audit_events BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION keep_audit_events();

-- What a changed value is recorded as: from and to for a short value; which keys changed for an
-- object; only that it changed for anything long.
CREATE FUNCTION audit_change(o jsonb, n jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE k text; keys text[] := '{}'; BEGIN
 IF jsonb_typeof(o) = 'object' AND jsonb_typeof(n) = 'object' THEN
  FOR k IN SELECT key FROM (SELECT key FROM jsonb_each(o) UNION SELECT key FROM jsonb_each(n)) x ORDER BY key LOOP
   IF (o->k) IS DISTINCT FROM (n->k) THEN keys := keys || k; END IF;
  END LOOP;
  RETURN jsonb_build_object('keys', to_jsonb(keys));
 END IF;
 IF length(COALESCE(o::text,'')) > 200 OR length(COALESCE(n::text,'')) > 200 THEN RETURN '{"changed":true}'; END IF;
 RETURN jsonb_build_object('from', o, 'to', n);
END $$;

-- One row change, audited. Arguments: the action's prefix, the target's type, its id columns
-- (joined with ':'), its name column, columns to ignore (noise, such as last-used times), and the
-- verbs for an insert and a delete. Secret columns are never copied: a change to one is recorded
-- only as "a secret was replaced".
CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE
 prefix text := TG_ARGV[0];
 target text := TG_ARGV[1];
 idkeys text[] := string_to_array(TG_ARGV[2], ',');
 namekey text := NULLIF(TG_ARGV[3], '');
 ignored text[] := string_to_array(COALESCE(TG_ARGV[4], ''), ',') || ARRAY['workspace_id','updated_at','updated_by','version','created_at','created_by'];
 o jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
 n jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
 r jsonb := COALESCE(n, o);
 d jsonb := '{}';
 secret_changed boolean := false;
 verb text;
 k text;
 tid text;
BEGIN
 IF TG_OP = 'UPDATE' THEN
  FOR k IN SELECT key FROM jsonb_each(n) LOOP
   CONTINUE WHEN k = ANY(ignored) OR (o->k) IS NOT DISTINCT FROM (n->k);
   IF k ~ '(secret|hash|sealed|token|wrapped|password|verify)' THEN secret_changed := true; CONTINUE; END IF;
   d := d || jsonb_build_object(k, audit_change(o->k, n->k));
  END LOOP;
  IF secret_changed THEN d := d || '{"secret":"replaced"}'; END IF;
  IF d = '{}' THEN RETURN NULL; END IF;
  verb := CASE
   WHEN d ? 'revoked_at' AND n->>'revoked_at' IS NOT NULL THEN 'revoked'
   WHEN d ? 'deleted_at' AND n->>'deleted_at' IS NOT NULL THEN 'deleted'
   WHEN d ? 'reversed_at' AND n->>'reversed_at' IS NOT NULL THEN 'reversed'
   WHEN d ? 'disabled_at' AND n->>'disabled_at' IS NOT NULL THEN 'disabled'
   WHEN (d ? 'archived_at' AND n->>'archived_at' IS NOT NULL) OR (d ? 'archived' AND (n->>'archived')::boolean) THEN 'archived'
   WHEN (d ? 'archived_at' AND n->>'archived_at' IS NULL) OR (d ? 'archived' AND NOT (n->>'archived')::boolean) THEN 'restored'
   WHEN d ? 'live_version' AND n->>'live_version' IS NOT NULL THEN 'published'
   WHEN d ? 'current_version' THEN 'published'
   ELSE 'changed' END;
 ELSE
  FOR k IN SELECT key FROM jsonb_each(r) LOOP
   CONTINUE WHEN k = ANY(ignored) OR k ~ '(secret|hash|sealed|token|wrapped|password|verify)' OR r->k = 'null'::jsonb;
   d := d || jsonb_build_object(k, CASE WHEN length((r->k)::text) > 200 THEN '"(long)"'::jsonb ELSE r->k END);
  END LOOP;
  verb := CASE TG_OP WHEN 'INSERT' THEN COALESCE(NULLIF(TG_ARGV[5], ''), 'created') ELSE COALESCE(NULLIF(TG_ARGV[6], ''), 'deleted') END;
 END IF;
 SELECT string_agg(r->>x, ':') INTO tid FROM unnest(idkeys) x;
 INSERT INTO audit_events(workspace_id,action,actor_type,actor_id,actor_name,via,target_type,target_id,target_name,details)
 VALUES (r->>'workspace_id', prefix || '.' || verb,
  CASE WHEN NULLIF(current_setting('relay.actor_id',true),'') IS NULL THEN 'system' ELSE 'teammate' END,
  NULLIF(current_setting('relay.actor_id',true),''), NULLIF(current_setting('relay.actor_name',true),''),
  NULLIF(current_setting('relay.actor_via',true),''),
  target, tid, CASE WHEN namekey IS NOT NULL THEN left(r->>namekey, 200) END, d);
 RETURN NULL;
END $$;

-- The administrative tables. Hot tables list only the columns that matter, so routing's and
-- presence's frequent writes never reach the trigger.
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION audit_row('role','role','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE ON role_capabilities FOR EACH ROW EXECUTE FUNCTION audit_row('role.permission','role','role_id','capability','','granted','removed');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF name,role_id,seat,schedule,conversation_limit,ticket_limit ON teammates FOR EACH ROW EXECUTE FUNCTION audit_row('teammate','teammate','id','name','presence,presence_changed_at,returned_at,notification_prefs,signature,timezone,principal_id');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF name,method,conversation_limit,ticket_limit,include_away,unassign_on_away ON teams FOR EACH ROW EXECUTE FUNCTION audit_row('team','team','id','name','tickets_count,rotation_cursor,view_id');
CREATE TRIGGER audit AFTER INSERT OR DELETE ON teammate_teams FOR EACH ROW EXECUTE FUNCTION audit_row('team.member','team','team_id','teammate_id','','added','removed');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON workspace_features FOR EACH ROW EXECUTE FUNCTION audit_row('feature','feature','name','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION audit_row('brand','brand','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON email_settings FOR EACH ROW EXECUTE FUNCTION audit_row('email_settings','brand','brand_id','support_address','forwarding_verified_at');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON email_domains FOR EACH ROW EXECUTE FUNCTION audit_row('email_domain','domain','domain','domain','checked_at,records,error,rate_per_minute,provider_verified');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON portal_settings FOR EACH ROW EXECUTE FUNCTION audit_row('portal_settings','workspace','workspace_id','');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON portal_domains FOR EACH ROW EXECUTE FUNCTION audit_row('portal_domain','domain','host','host');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON voice_settings FOR EACH ROW EXECUTE FUNCTION audit_row('voice_settings','workspace','workspace_id','','last_search,searched_at');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON outbound_settings FOR EACH ROW EXECUTE FUNCTION audit_row('outbound_settings','workspace','workspace_id','');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON ai_monitor_settings FOR EACH ROW EXECUTE FUNCTION audit_row('zoe.monitor','monitor','metric','metric');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON sms_accounts FOR EACH ROW EXECUTE FUNCTION audit_row('sms_account','channel','account_sid','friendly_name','status,error,checked_at');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON sms_numbers FOR EACH ROW EXECUTE FUNCTION audit_row('sms_number','channel','id','phone','status,error,voice_error');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON whatsapp_numbers FOR EACH ROW EXECUTE FUNCTION audit_row('whatsapp_number','channel','id','display_number','quality,status,error,checked_at,verified_name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON meta_pages FOR EACH ROW EXECUTE FUNCTION audit_row('meta_page','channel','id','page_name','status,error,checked_at');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON community_connections FOR EACH ROW EXECUTE FUNCTION audit_row('community','channel','id','name','status,error,gateway_state,gateway_at,checked_at');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON ai_agents FOR EACH ROW EXECUTE FUNCTION audit_row('zoe','zoe','id','name','writes_paused_at,writes_paused_by');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON ai_agent_identities FOR EACH ROW EXECUTE FUNCTION audit_row('zoe.identity','brand','brand_id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON ai_escalation_rules FOR EACH ROW EXECUTE FUNCTION audit_row('zoe.escalation_rule','rule','id','name','position');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON ai_specialists FOR EACH ROW EXECUTE FUNCTION audit_row('zoe.specialist','specialist','id','name','position');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON ai_connectors FOR EACH ROW EXECUTE FUNCTION audit_row('connector','connector','id','name','writes_enabled_at,writes_enabled_by');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON ai_connector_secrets FOR EACH ROW EXECUTE FUNCTION audit_row('connector.secret','connector','connector_id','name','hint');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON ai_procedures FOR EACH ROW EXECUTE FUNCTION audit_row('procedure','procedure','id','name','source');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION audit_row('workflow','workflow','id','name','draft,layout,schedule_next_at');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON outbound_messages FOR EACH ROW EXECUTE FUNCTION audit_row('outbound','outbound','id','title','draft');
-- Personal tokens only: an app's hourly tokens are its installation's, audited there.
CREATE TRIGGER audit AFTER INSERT ON api_tokens FOR EACH ROW WHEN (NEW.grant_id IS NULL) EXECUTE FUNCTION audit_row('api_token','api_token','id','name');
CREATE TRIGGER audit_change AFTER UPDATE OF name,scopes,revoked_at ON api_tokens FOR EACH ROW WHEN (NEW.grant_id IS NULL) EXECUTE FUNCTION audit_row('api_token','api_token','id','name','last_used_at,revoked_by');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON oauth_apps FOR EACH ROW EXECUTE FUNCTION audit_row('oauth_app','app','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON oauth_grants FOR EACH ROW EXECUTE FUNCTION audit_row('app_install','app','id','app_name','configured_at,app_workspace_id');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION audit_row('webhook','webhook','id','url','failing_since,previous_until');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON sla_policies FOR EACH ROW EXECUTE FUNCTION audit_row('sla_policy','sla','id','name','position');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON calendars FOR EACH ROW EXECUTE FUNCTION audit_row('office_hours','calendar','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON attribute_definitions FOR EACH ROW EXECUTE FUNCTION audit_row('attribute','attribute','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON tags FOR EACH ROW EXECUTE FUNCTION audit_row('tag','tag','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON ticket_types FOR EACH ROW EXECUTE FUNCTION audit_row('ticket_type','ticket_type','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON subscription_types FOR EACH ROW EXECUTE FUNCTION audit_row('subscription_type','subscription_type','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON segments FOR EACH ROW EXECUTE FUNCTION audit_row('segment','segment','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON help_centers FOR EACH ROW EXECUTE FUNCTION audit_row('help_center','help_center','id','name');
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION audit_row('knowledge_source','knowledge_source','id','name','status,next_run_at,page_count');
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON contact_merges FOR EACH ROW EXECUTE FUNCTION audit_row('contact.merge','contact','survivor_id','','changes,loser_id','merged');
CREATE TRIGGER audit AFTER INSERT OR DELETE ON identity_keys FOR EACH ROW EXECUTE FUNCTION audit_row('identity_key','identity_key','kid','kid','slot');
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON audit_settings FOR EACH ROW EXECUTE FUNCTION audit_row('audit_settings','workspace','workspace_id','');
