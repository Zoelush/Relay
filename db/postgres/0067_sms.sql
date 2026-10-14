-- SMS (phase 12, step E6; docs/OMNICHANNEL_STEP6.md), behind `channels_v1` and `channel_sms_v1`,
-- through Twilio with the workspace's own account. Additive.

-- The workspace's Twilio account: its SID and auth token (sealed with RELAY_CONNECTOR_KEY, never
-- shown again; the token also signs Twilio's webhook calls), and the reply to HELP.
CREATE TABLE sms_accounts (
 workspace_id text NOT NULL, account_sid text NOT NULL, token_sealed text NOT NULL, token_hint text NOT NULL DEFAULT '',
 friendly_name text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','failed')),
 error text NOT NULL DEFAULT '', help_reply text NOT NULL DEFAULT '' CHECK(length(help_reply)<=320),
 checked_at timestamptz, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id));

-- A brand's numbers, one per country it texts from (by calling code); a reply goes from the
-- number in the customer's country, else the brand's default.
CREATE TABLE sms_numbers (
 workspace_id text NOT NULL, id text NOT NULL, brand_id text NOT NULL, phone text NOT NULL, calling_code text NOT NULL,
 number_sid text, is_default boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','failed','removed')), error text NOT NULL DEFAULT '',
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id));
CREATE UNIQUE INDEX sms_numbers_phone ON sms_numbers(workspace_id,phone) WHERE status<>'removed';

-- Consent to be texted: the customer texting first, a teammate's record of consent given
-- elsewhere (with where), or START. One active per number; withdrawal is the suppression list.
CREATE TABLE sms_consents (
 workspace_id text NOT NULL, id text NOT NULL, phone text NOT NULL,
 source text NOT NULL CHECK(source IN ('customer_message','recorded','keyword')), note text NOT NULL DEFAULT '',
 created_by text, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX sms_consents_active ON sms_consents(workspace_id,phone) WHERE revoked_at IS NULL;

-- What a segment costs to text a country (by calling code), for the composer's estimate.
CREATE TABLE sms_prices (
 workspace_id text NOT NULL, calling_code text NOT NULL, per_segment numeric(10,5) NOT NULL CHECK(per_segment>=0),
 currency text NOT NULL DEFAULT 'USD' CHECK(currency ~ '^[A-Z]{3}$'),
 PRIMARY KEY(workspace_id,calling_code));

-- Each webhook call (a message, or a sent message's status), kept until the `sms.receive` job reads
-- it (its signature was checked before it was kept).
CREATE TABLE sms_inbound (
 workspace_id text NOT NULL, id text NOT NULL, kind text NOT NULL CHECK(kind IN ('message','status')), payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','read','failed')), error text NOT NULL DEFAULT '',
 received_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 PRIMARY KEY(workspace_id,id));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sms_accounts','sms_numbers','sms_consents','sms_prices','sms_inbound'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'channel_sms_v1',false FROM workspace ON CONFLICT DO NOTHING;
