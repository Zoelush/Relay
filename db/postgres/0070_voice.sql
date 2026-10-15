-- Voice (phase 12, step E9; docs/OMNICHANNEL_STEP9.md), behind `channels_v1`, `channel_voice_v1`
-- and SMS's Twilio account (E6). Additive.

-- The workspace's calls: Zoe on calls (off by default), recording consent (the default and per
-- calling code: none, announced, or asked), transcription, the voicemail greeting, how long each
-- teammate is rung.
CREATE TABLE voice_settings (
 workspace_id text NOT NULL, zoe boolean NOT NULL DEFAULT false,
 recording_default text NOT NULL DEFAULT 'consent' CHECK(recording_default IN ('none','announce','consent')),
 recording_overrides jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(recording_overrides)='object'),
 transcription boolean NOT NULL DEFAULT true,
 voicemail_greeting text NOT NULL DEFAULT '' CHECK(length(voicemail_greeting)<=500),
 ring_seconds integer NOT NULL DEFAULT 20 CHECK(ring_seconds BETWEEN 10 AND 60),
 -- The last search for numbers to buy (a job asks Twilio), and when.
 last_search jsonb NOT NULL DEFAULT '{}', searched_at timestamptz,
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id));

-- Teammates who take calls, and the phone a warm transfer rings.
CREATE TABLE voice_agents (
 workspace_id text NOT NULL, teammate_id text NOT NULL, phone text NOT NULL, takes_calls boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,teammate_id), FOREIGN KEY(workspace_id,teammate_id) REFERENCES teammates(workspace_id,id));

-- Each call: who, to which number, its conversation, consent, Zoe's turns and the caller's
-- silences, the transfer (who's being rung, who took it), its recording, and how it ended.
CREATE TABLE voice_calls (
 workspace_id text NOT NULL, id text NOT NULL, call_sid text NOT NULL, conversation_id text, number_id text NOT NULL,
 from_phone text NOT NULL, to_phone text NOT NULL,
 status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed','busy','no_answer','failed','canceled')),
 recording text NOT NULL DEFAULT 'none' CHECK(recording IN ('none','announce','consent')),
 consent text NOT NULL DEFAULT 'not_asked' CHECK(consent IN ('not_asked','granted','declined')),
 zoe_turns integer NOT NULL DEFAULT 0, silences integer NOT NULL DEFAULT 0,
 ringing_teammate text, ringing_index integer NOT NULL DEFAULT 0, accepted_by text, voicemail boolean NOT NULL DEFAULT false,
 recording_sid text, duration_seconds integer, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,call_sid));
CREATE INDEX voice_calls_conversation ON voice_calls(workspace_id,conversation_id);

-- Recordings and voicemails Twilio reports (signed), until the `voice.recording` job reads them.
CREATE TABLE voice_inbound (
 workspace_id text NOT NULL, id text NOT NULL, call_sid text NOT NULL, kind text NOT NULL CHECK(kind IN ('call','voicemail')), payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','read','failed')), error text NOT NULL DEFAULT '',
 received_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,call_sid,kind));

-- Which of the Twilio numbers take calls (E6's numbers, now for voice too).
ALTER TABLE sms_numbers ADD COLUMN voice boolean NOT NULL DEFAULT false;
ALTER TABLE sms_numbers ADD COLUMN voice_error text NOT NULL DEFAULT '';

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['voice_settings','voice_agents','voice_calls','voice_inbound'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''relay.workspace_id'',true))',t);
 END LOOP;
END $$;

INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'channel_voice_v1',false FROM workspace ON CONFLICT DO NOTHING;
