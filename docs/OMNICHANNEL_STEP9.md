# Phase 12, step E9: Voice

Branch `omnichannel/e9-voice`. Plan: `docs/OMNICHANNEL_PLAN.md`. Behind `channel_voice_v1` (and `channels_v1`), off by default and on for the local relay. This is the last step of phase 12.

## What it does

Calls to a brand's numbers become conversations on a new channel, `voice`. The numbers and the account are SMS's (E6): one Twilio account, and its numbers take texts and, when switched on, calls.

**A call, step by step.** Twilio's webhook (`/v1/hooks/voice/<workspace>/<step>`) is checked against its signature (the account's token, over the exact URL and form) on every step, and each step answers with TwiML:

1. **Incoming:**
   - The call is a conversation on voice, threaded with the same number's calls within a day.
   - The caller's number is unverified, since caller ID can be faked.
   - The greeting names the brand.
2. **Recording consent, by the caller's calling code** (a default, and per-country overrides):
   - **Don't record.**
   - **Record, and say so:** "This call is recorded and transcribed."
   - **Ask first:** press 1 to agree, or 2 to continue without recording. No answer means no recording.
   - Recording starts only once allowed (a job asks Twilio to record both sides).
3. **Zoe answers** when she's on for calls (Settings › Voice), she's on for the workspace, and the call is recorded. Recording is how she hears, so she never listens to a call that isn't recorded.
   - **What the caller says** (speech recognised by Twilio) is their message.
   - **Her reply comes from her own pipeline** (the `ai.reply` job, with retrieval, guards and handover, exactly as on any channel). The call waits for it (up to 10 seconds) and says it.
   - **Made to be spoken** (`lib/voice.ts`): links, formatting and lists become plain sentences, and a long answer stops at a sentence and offers to go on.
   - **Barge-in:** the caller can talk over her.
4. **The silence policy and other hand-offs to the team:**
   - Silence once: she asks again. Twice: the team.
   - More than eight turns: the team.
   - Her handover (asked for a person, failed answers, frustration): the team.
   - No answer from her within 10 seconds: the team.
5. **A warm transfer:**
   - Teammates who take calls (each with their phone, Settings › Voice) and are active are rung one at a time, for the workspace's ring time (10 to 60 seconds, 20 by default).
   - Each teammate hears a whisper first: who's calling and what they've said. They press 1 to take it; anything else, or no answer, rings the next.
   - The same context is written into the conversation as an internal note when the transfer starts.
   - Who took it is an event in the timeline.
6. **Voicemail:** when nobody takes the call, or office hours (the brand's or team's calendar, as for every channel) are closed.
   - The workspace's greeting, or a default, then up to 2 minutes, ending on # or silence.
   - Leaving a voicemail is itself agreeing to be recorded (they're told), even if the call wasn't.
7. **The end of the call** is an event ("Call ended after 1:35", "not answered", "hung up before it was answered").

**Recordings and transcripts** (the `voice.recording` job, from Twilio's signed recording callback, kept once per call and kind):
- **Stored** as an internal attachment (`audio/mpeg`), for the team only.
- **Transcribed** when transcription is on (Workers AI's Whisper, `@cf/openai/whisper`, behind `TranscriptionPort`):
  - a voicemail becomes the caller's message, "Voicemail: …"
  - a call's transcript is written into the conversation line by line, with times, as internal events

**A call can't be answered in writing.** A teammate's written reply to a voice conversation is refused when written ("A call can't be answered in writing: call them back, or text them."), and the composer says so. Only Zoe's replies, during a live call, are "delivered", by being said.

**Settings › Voice** (managers):
- **Numbers:** which of the account's numbers take calls (switching one on points its calls at Relay).
- **Buying a number:** search a country, choose one, then confirm (it's charged to the Twilio account). It's added for texts and calls.
- **Calls:** recording (the default and per country), Zoe on calls, transcription, the voicemail greeting and the ring time.
- **Teammates' phones**, and whether each takes calls.
- **The latest 20 calls.**

## How it works

**Migration `0070_voice`:**
- `voice_settings`: the workspace's call settings, and the last number search
- `voice_agents`: teammates' phones
- `voice_calls`: each call's consent, Zoe's turns, silences, the transfer, the recording and how it ended
- `voice_inbound`: recordings reported, until read
- `sms_numbers.voice` and `voice_error`
- row-level security, and the flag
- **The rollback:** the flag goes off (calls are told the number isn't taking calls, and hung up), calls in progress are marked failed, and unread recordings fail.

**Voice:**
- **`server/voice.ts`:**
  - the adapter (`voiceChannel`):
    - `aiAnswers`: only what was said on a live call, with Zoe on for calls
    - `refuses`: everything but Zoe's reply on a live call
  - `voiceHook` and its steps
  - the jobs: `voice.record`, `voice.recording`, `voice.number`, `voice.search`, `voice.buy`
  - Settings' read and actions: `settings`, `number`, `search`, `buy` (confirmed, and only a number the last search offered), `agent`
- **`server/voice-transcribe.ts`:** `TranscriptionPort` and the Workers AI transcriber.
- **`lib/voice.ts`:** `speakable` and the speech languages (Zoe's first language).
- **`server/sms-api.ts`:** `configureVoice`, `searchNumbers`, `buyNumber` and `startRecording`.

**Elsewhere:**
- **The Worker:** the jobs, with Whisper from the `AI` binding.
- **Routes:** `POST /v1/hooks/voice/<workspace>/<step>`, and `GET` and `POST voice-settings`.
- **Local relay:**
  - the SMS stand-in's voice methods, `call` and `recorded`
  - a stand-in transcriber
  - the seed: the demo's UK number takes calls, Zoe answers calls, and the owner's phone is rung for transfers
- **UI:**
  - `agent/settings-voice.tsx`
  - the label "Phone"
  - the timeline's call events and transcript lines
  - "Phone call to …" in the composer

## Trying it locally

`npm run dev:relay` seeds a number that takes calls. Twilio's calls are signed, so the easiest way through a call is `tests/browser/voice.spec.ts`, which walks each step with `relay.sms.call` and `relay.sms.signed`.

## Deploying (not done: needs you)

- **A Twilio account and numbers** (E6), with Programmable Voice. Switching a number on in Settings › Voice points its calls at Relay; recordings use Twilio's storage until Relay copies them.
- **Workers AI** bound as `AI` for transcripts (Whisper).
- **`RELAY_CONNECTOR_KEY` set.**
- **Check the recording laws where your callers are.** The defaults ask first everywhere; per-country settings can say so or turn recording off.

## Checks

- **`tests/voice.test.ts`:**
  - **Spoken text:** links, marks, lists, numbers, and long answers cut at a sentence.
  - **Settings:** off by default; managers only; settings checked; a number's calls pointed at Relay; teammates' phones.
  - **The hook:** a forged signature, another account and another workspace are refused, with nothing kept. Twilio's retried step is the same call.
  - **A call asked first and agreed:** recorded from then. Zoe answers through her pipeline, and her reply is said and delivered. A teammate's written reply is refused. Her handover leads to a warm transfer: the context note, the whisper, the first teammate not taking it, the next pressing 1. Then the call's end, and its recording stored and transcribed once.
  - **A caller who declines:** not recorded and no Zoe. Nobody takes it, so voicemail, which becomes their message, transcribed.
  - **A US caller is told it's recorded:** two silences go to the team, and so does the turn limit.
  - **Germany isn't recorded.**
  - **An unknown call** is hung up.
  - **Buying:** a refused search; nothing bought until confirmed and offered; bought once.
  - **Another workspace:** its own settings, and a's conversations aren't readable.
  - **The rollback.**
- **`tests/browser/voice.spec.ts`** (ports 9052 and 9053):
  - **Happy path:** a call recorded with consent and transferred warm; its end, transfer and transcript in the timeline; the composer's note; Settings shows the number and the call, and buys a number only once confirmed.
  - **Failure path:** a forged call is refused. A caller who declines recording and finds nobody leaves a voicemail that becomes a conversation. A written reply is refused. A search Twilio refuses says why.

## Not included

- **Outbound calls** (calling a customer from Relay), and calls in the browser (a softphone): teammates take calls on their own phones.
- **Zoe through media streams** (live audio, lower latency): she hears by Twilio's speech recognition, turn by turn.
- **Queues with hold music, and IVR menus.**
- **Releasing a bought number** (do it in Twilio).
