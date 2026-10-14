-- Email out (phase 12, step E3; docs/OMNICHANNEL_STEP3.md), behind `channels_v1` and `channel_email_v1`.
-- Additive.

-- A brand sends from its support address's domain once the domain is proven: Relay's ownership
-- record (a TXT with this workspace's token, so nobody can send as a domain another workspace
-- set up) and the provider's DKIM records. SPF (on the bounce subdomain) and DMARC are checked
-- and shown. Until then the brand sends from Relay's own address.
CREATE TABLE email_domains (
 workspace_id text NOT NULL, domain text NOT NULL, ownership_token text NOT NULL,
 dkim_tokens text[] NOT NULL DEFAULT '{}', records jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','failed')),
 provider_verified boolean NOT NULL DEFAULT false, error text NOT NULL DEFAULT '',
 rate_per_minute integer NOT NULL DEFAULT 60 CHECK(rate_per_minute BETWEEN 1 AND 10000),
 checked_at timestamptz, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,domain));

-- Each conversation's own reply address (`<workspace>+r-<token>@<inbound domain>`): mail to it
-- joins that conversation. The token is random and unguessable; it isn't derived from the id.
CREATE TABLE email_reply_addresses (
 workspace_id text NOT NULL, token text NOT NULL, conversation_id text NOT NULL, brand_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,token), UNIQUE(workspace_id,conversation_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));

-- Sends per sending domain per minute (the rate limit).
CREATE TABLE email_send_counts (
 workspace_id text NOT NULL, domain text NOT NULL, minute timestamptz NOT NULL, sent integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,domain,minute));

-- The provider's reports, once each (its message id): deliveries, bounces and complaints, for
-- delivery status and the reputation figures.
CREATE TABLE email_events (
 workspace_id text NOT NULL, id text NOT NULL, delivery_id text, domain text NOT NULL DEFAULT '',
 kind text NOT NULL CHECK(kind IN ('delivery','bounce','soft_bounce','complaint')), detail text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id));
CREATE INDEX email_events_domain ON email_events(workspace_id,domain,created_at);

-- Messenger customers who are away get an email of the replies they haven't read: once per reply.
CREATE TABLE email_away (
 workspace_id text NOT NULL, conversation_id text NOT NULL, through_seq bigint NOT NULL, sent_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,conversation_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));

-- Away emails, per brand: on, and whether they carry the replies themselves.
ALTER TABLE email_settings ADD COLUMN away_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE email_settings ADD COLUMN away_content boolean NOT NULL DEFAULT false;
ALTER TABLE email_settings ADD COLUMN away_minutes integer NOT NULL DEFAULT 10 CHECK(away_minutes BETWEEN 1 AND 1440);

-- A delivery is a reply on its channel, or an away email for a messenger conversation; the domain
-- it went from (for reputation); and when a rate-limited one may go.
ALTER TABLE channel_deliveries ADD COLUMN purpose text NOT NULL DEFAULT 'reply' CHECK(purpose IN ('reply','away'));
ALTER TABLE channel_deliveries ADD COLUMN domain text;
ALTER TABLE channel_deliveries ADD COLUMN not_before timestamptz;
CREATE INDEX channel_deliveries_deferred ON channel_deliveries(workspace_id,not_before) WHERE not_before IS NOT NULL;
CREATE INDEX channel_deliveries_domain ON channel_deliveries(workspace_id,domain,created_at) WHERE domain IS NOT NULL;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['email_domains','email_reply_addresses','email_send_counts','email_events','email_away'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;
