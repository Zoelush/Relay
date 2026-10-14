-- WhatsApp Business (phase 12, step E5; docs/OMNICHANNEL_STEP5.md), behind `channels_v1` and
-- `channel_whatsapp_v1`. Additive.

-- A brand's WhatsApp number, connected with the workspace's own Meta app (Meta's Cloud API,
-- directly): its ids, its access token and app secret (sealed with RELAY_CONNECTOR_KEY, never
-- shown again), and the verify token Meta's webhook setup is answered with.
CREATE TABLE whatsapp_numbers (
 workspace_id text NOT NULL, id text NOT NULL, brand_id text NOT NULL,
 phone_number_id text NOT NULL, waba_id text NOT NULL,
 display_number text NOT NULL DEFAULT '', verified_name text NOT NULL DEFAULT '', quality text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','failed','disconnected')),
 token_sealed text NOT NULL, token_hint text NOT NULL DEFAULT '', app_secret_sealed text NOT NULL, verify_token text NOT NULL,
 error text NOT NULL DEFAULT '', checked_at timestamptz, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,phone_number_id),
 FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));

-- Message templates: submitted to Meta for approval, kept with their status. Only an approved
-- template may be sent, and only a template may go once the 24-hour window has closed.
CREATE TABLE whatsapp_templates (
 workspace_id text NOT NULL, id text NOT NULL, number_id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 512 AND name ~ '^[a-z0-9_]+$'), language text NOT NULL, category text NOT NULL CHECK(category IN ('utility','marketing','authentication')),
 body text NOT NULL, examples jsonb NOT NULL DEFAULT '[]', params integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paused','disabled')),
 provider_id text, reason text NOT NULL DEFAULT '', created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,number_id,name,language),
 FOREIGN KEY(workspace_id,number_id) REFERENCES whatsapp_numbers(workspace_id,id));

-- Opt-ins: a number's permission to be messaged on WhatsApp (the customer writing first, or a
-- teammate's record of consent given elsewhere), and its withdrawal (STOP). One active per number.
CREATE TABLE whatsapp_opt_ins (
 workspace_id text NOT NULL, id text NOT NULL, phone text NOT NULL,
 source text NOT NULL CHECK(source IN ('customer_message','recorded','keyword')), note text NOT NULL DEFAULT '',
 created_by text, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, revoked_by text,
 PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX whatsapp_opt_ins_active ON whatsapp_opt_ins(workspace_id,phone) WHERE revoked_at IS NULL;

-- Each webhook call, kept until read by the `whatsapp.receive` job (its signature was checked
-- before it was kept).
CREATE TABLE whatsapp_inbound (
 workspace_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','read','failed')), error text NOT NULL DEFAULT '',
 received_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 PRIMARY KEY(workspace_id,id));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['whatsapp_numbers','whatsapp_templates','whatsapp_opt_ins','whatsapp_inbound'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'channel_whatsapp_v1',false FROM workspace ON CONFLICT DO NOTHING;
