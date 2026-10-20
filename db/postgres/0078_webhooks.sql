-- Webhooks (phase 15, step D3; docs/DEVELOPER_PLATFORM_STEP3.md), behind `developer_api_v1`.
-- Additive. Events are written by the database itself, in the same transaction as the change (as
-- R1's snapshots are), so every way something changes is covered; and only while a subscription
-- wants that topic, so a workspace without webhooks writes nothing extra.
CREATE TABLE webhook_subscriptions (
 workspace_id text NOT NULL REFERENCES workspace(id), id text NOT NULL,
 url text NOT NULL CHECK(length(url) BETWEEN 8 AND 2000),
 topics text[] NOT NULL CHECK(cardinality(topics) BETWEEN 1 AND 50),
 version text NOT NULL,
 -- The signing secret, sealed with the connector key; while rotating, the previous one too.
 secret_sealed text NOT NULL, previous_secret_sealed text, previous_until timestamptz,
 active boolean NOT NULL DEFAULT true, failing_since timestamptz, disabled_at timestamptz, disabled_reason text,
 alert_email text CHECK(alert_email IS NULL OR length(alert_email) BETWEEN 3 AND 320),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 PRIMARY KEY(workspace_id,id));
CREATE TABLE webhook_events (
 workspace_id text NOT NULL, id text NOT NULL, topic text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp(), dispatched_at timestamptz,
 PRIMARY KEY(workspace_id,id));
CREATE INDEX webhook_events_pending ON webhook_events(workspace_id,created_at,id) WHERE dispatched_at IS NULL;
CREATE TABLE webhook_deliveries (
 workspace_id text NOT NULL, id text NOT NULL, subscription_id text NOT NULL, event_id text NOT NULL, topic text NOT NULL,
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','abandoned')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), first_attempt_at timestamptz,
 delivered_at timestamptz, last_status integer, last_error text NOT NULL DEFAULT '', replay_of text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,subscription_id) REFERENCES webhook_subscriptions(workspace_id,id));
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(workspace_id,next_attempt_at) WHERE status='pending';
CREATE INDEX webhook_deliveries_log ON webhook_deliveries(workspace_id,subscription_id,created_at DESC,id DESC);
-- Every attempt, what came back (the first 1 KB), kept 30 days.
CREATE TABLE webhook_attempts (
 workspace_id text NOT NULL, id text NOT NULL, delivery_id text NOT NULL, attempted_at timestamptz NOT NULL DEFAULT now(),
 status_code integer, duration_ms integer NOT NULL, error text NOT NULL DEFAULT '', response_excerpt text NOT NULL DEFAULT '',
 PRIMARY KEY(workspace_id,id));
CREATE INDEX webhook_attempts_delivery ON webhook_attempts(workspace_id,delivery_id,attempted_at);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['webhook_subscriptions','webhook_events','webhook_deliveries','webhook_attempts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

-- An event, only if an active subscription wants its topic.
CREATE FUNCTION webhook_emit(w text, t text, rtype text, rid text, d jsonb) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS (SELECT 1 FROM webhook_subscriptions s WHERE s.workspace_id=w AND s.active AND s.deleted_at IS NULL AND t=ANY(s.topics)) THEN
  INSERT INTO webhook_events(workspace_id,id,topic,resource_type,resource_id,detail) VALUES(w,gen_random_uuid()::text,t,rtype,rid,d);
 END IF;
END $$;

CREATE FUNCTION webhook_part() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t text; BEGIN
 t := CASE
  WHEN NEW.kind='customer_message' THEN 'conversation.customer_replied'
  WHEN NEW.kind='teammate_reply' AND NEW.audience='public' THEN 'conversation.teammate_replied'
  WHEN NEW.kind='assignment_change' THEN 'conversation.assigned'
  WHEN NEW.kind='state_change' AND NEW.data->>'to'='closed' THEN 'conversation.closed'
  WHEN NEW.kind='rating' THEN 'conversation.rated'
  WHEN NEW.kind='tag_change' AND NEW.data->>'action'='tag_add' THEN 'conversation.tagged'
  WHEN NEW.kind='ai_reply' AND COALESCE((NEW.data->>'handover')::boolean,false) THEN 'ai_agent.escalated'
  WHEN NEW.kind='system_event' AND NEW.data->>'event'='sla_breached' THEN 'sla.breached'
  ELSE NULL END;
 IF t IS NOT NULL THEN
  PERFORM webhook_emit(NEW.workspace_id,t,'conversation',NEW.conversation_id,jsonb_build_object('part_id',NEW.id,'tag_id',NEW.data->>'tagId','metric',NEW.data->>'metric'));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_part AFTER INSERT ON conversation_parts FOR EACH ROW EXECUTE FUNCTION webhook_part();

CREATE FUNCTION webhook_conversation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.visibility='customer' THEN PERFORM webhook_emit(NEW.workspace_id,'conversation.created','conversation',NEW.id,'{}'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_conversation AFTER INSERT ON conversations FOR EACH ROW EXECUTE FUNCTION webhook_conversation();

CREATE FUNCTION webhook_contact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM webhook_emit(NEW.workspace_id,'contact.created','contact',NEW.id,'{}');
 ELSIF NEW.merged_into_contact_id IS NOT NULL AND OLD.merged_into_contact_id IS NULL THEN
  PERFORM webhook_emit(NEW.workspace_id,'contact.merged','contact',NEW.merged_into_contact_id,jsonb_build_object('merged_contact_id',NEW.id));
 ELSIF (NEW.name,NEW.role,NEW.profile,NEW.external_id) IS DISTINCT FROM (OLD.name,OLD.role,OLD.profile,OLD.external_id) THEN
  PERFORM webhook_emit(NEW.workspace_id,'contact.updated','contact',NEW.id,'{}');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_contact AFTER INSERT OR UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION webhook_contact();

CREATE FUNCTION webhook_contact_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM webhook_emit(NEW.workspace_id,'event.received','event',NEW.id,jsonb_build_object('contact_id',NEW.contact_id));
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_contact_event AFTER INSERT ON contact_events FOR EACH ROW EXECUTE FUNCTION webhook_contact_event();

CREATE FUNCTION webhook_ticket() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM webhook_emit(NEW.workspace_id,'ticket.created','ticket',NEW.conversation_id,'{}');
 ELSIF NEW.state_id IS DISTINCT FROM OLD.state_id THEN
  PERFORM webhook_emit(NEW.workspace_id,'ticket.state_changed','ticket',NEW.conversation_id,jsonb_build_object('from_state_id',OLD.state_id,'to_state_id',NEW.state_id));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_ticket AFTER INSERT OR UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION webhook_ticket();

CREATE FUNCTION webhook_resolution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind='resolution' THEN PERFORM webhook_emit(NEW.workspace_id,'ai_agent.resolved','conversation',NEW.conversation_id,jsonb_build_object('resolution_id',NEW.id)); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_resolution AFTER INSERT ON ai_resolutions FOR EACH ROW EXECUTE FUNCTION webhook_resolution();

CREATE FUNCTION webhook_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS (SELECT 1 FROM knowledge_records r WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.record_id AND r.source='article') THEN
  PERFORM webhook_emit(NEW.workspace_id,'article.published','article',NEW.record_id,jsonb_build_object('locale',NEW.locale,'revision',NEW.revision));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_revision AFTER INSERT ON knowledge_revisions FOR EACH ROW EXECUTE FUNCTION webhook_revision();

-- A subscription disabled after failing for 24 hours: its creator is told in Relay, and by email
-- when the subscription names an address (through the one alert email path, `sendAlert`).
ALTER TABLE notifications ADD COLUMN webhook_subscription_id text;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('mention','zoe_incident','workflow_alert','webhook_disabled'));
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_fields;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_fields CHECK(
 CASE kind
  WHEN 'mention' THEN conversation_id IS NOT NULL AND part_id IS NOT NULL AND actor_teammate_id IS NOT NULL AND incident_id IS NULL AND workflow_alert_id IS NULL AND webhook_subscription_id IS NULL
  WHEN 'zoe_incident' THEN incident_id IS NOT NULL AND conversation_id IS NULL AND part_id IS NULL AND workflow_alert_id IS NULL AND webhook_subscription_id IS NULL
  WHEN 'workflow_alert' THEN workflow_alert_id IS NOT NULL AND incident_id IS NULL AND conversation_id IS NULL AND part_id IS NULL AND webhook_subscription_id IS NULL
  ELSE webhook_subscription_id IS NOT NULL AND incident_id IS NULL AND conversation_id IS NULL AND part_id IS NULL AND workflow_alert_id IS NULL END);
ALTER TABLE email_alerts ALTER COLUMN incident_id DROP NOT NULL;
ALTER TABLE email_alerts ADD COLUMN kind text NOT NULL DEFAULT 'incident' CHECK(kind IN ('incident','webhook_disabled'));
ALTER TABLE email_alerts ADD COLUMN webhook_subscription_id text;
ALTER TABLE email_alerts ADD CONSTRAINT email_alerts_kind_fields CHECK((kind='incident') = (incident_id IS NOT NULL) AND (kind='webhook_disabled') = (webhook_subscription_id IS NOT NULL));
