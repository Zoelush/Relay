/**
 * Transcription (phase 12, step E9; docs/OMNICHANNEL_STEP9.md), behind a port: a call's recording
 * or a voicemail into text with its timings. Deployed, Workers AI's Whisper; tests and the local
 * relay use a stand-in. Only recordings the caller agreed to (or was told of) reach it.
 */
export type Transcript = { text: string; segments: { start: number; end: number; text: string }[] };
export interface TranscriptionPort {
  transcribe(audio: Uint8Array, mime: string): Promise<Transcript>;
}
export type WorkersAiSpeech = { run(model: string, input: { audio: number[] }): Promise<unknown> };
export function workersAiTranscriber(ai: WorkersAiSpeech): TranscriptionPort {
  return {
    async transcribe(audio) {
      const out = (await ai.run("@cf/openai/whisper", { audio: [...audio] })) as {
        text?: string;
        segments?: { start?: number; end?: number; text?: string }[];
        words?: { start?: number; end?: number; word?: string }[];
      };
      const segments = (out.segments ?? []).map((s) => ({ start: Number(s.start ?? 0), end: Number(s.end ?? 0), text: String(s.text ?? "").trim() })).filter((s) => s.text);
      return { text: String(out.text ?? segments.map((s) => s.text).join(" ")).trim(), segments: segments.length ? segments : out.text ? [{ start: 0, end: 0, text: String(out.text).trim() }] : [] };
    },
  };
}
