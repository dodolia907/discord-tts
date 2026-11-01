import { ensureOk, type TtsClient, type Voice, withTimeout } from "./client.js";

interface Speaker {
  name: string;
  styles: { id: number; name: string; type?: string }[];
}

/** These styles need a score rather than text, so they cannot read chat. */
const NON_SPEECH_TYPES = new Set(["sing", "frame_decode"]);

export function voicevoxClient(baseUrl: string, initialSpeaker: number): TtsClient {
  let speaker = initialSpeaker;

  const fetchSpeakers = async (signal: AbortSignal): Promise<Speaker[]> => {
    const res = await fetch(`${baseUrl}/speakers`, { signal: withTimeout(signal) });
    await ensureOk(res, "VOICEVOX speaker lookup");
    return (await res.json()) as Speaker[];
  };

  const initialize = async (id: number, signal: AbortSignal): Promise<void> => {
    const res = await fetch(`${baseUrl}/initialize_speaker?speaker=${id}&skip_reinit=true`, {
      method: "POST",
      signal: withTimeout(signal),
    });
    await ensureOk(res, "VOICEVOX speaker initialization");
  };

  return {
    prepare: (signal) => initialize(speaker, signal),

    async credit(signal) {
      const speakers = await fetchSpeakers(signal);
      const found = speakers.find((s) => s.styles.some((style) => style.id === speaker));
      if (!found) {
        throw new Error(`VOICEVOX has no style with id ${speaker}`);
      }
      return `VOICEVOX:${found.name}`;
    },

    async voices(signal): Promise<Voice[]> {
      const speakers = await fetchSpeakers(signal);
      return speakers.flatMap((s) =>
        s.styles
          .filter((style) => !NON_SPEECH_TYPES.has(style.type ?? ""))
          .map((style) => ({ id: style.id, label: `${s.name}(${style.name})` })),
      );
    },

    async selectVoice(id, signal) {
      await initialize(id, signal);
      speaker = id;
    },

    async synthesize(text, signal) {
      const timed = withTimeout(signal);
      const params = new URLSearchParams({ text, speaker: String(speaker) });
      const query = await fetch(`${baseUrl}/audio_query?${params}`, { method: "POST", signal: timed });
      await ensureOk(query, "VOICEVOX audio_query");

      const res = await fetch(`${baseUrl}/synthesis?speaker=${speaker}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await query.text(),
        signal: timed,
      });
      await ensureOk(res, "VOICEVOX synthesis");
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
