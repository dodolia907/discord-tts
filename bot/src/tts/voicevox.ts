import { ensureOk, type TtsClient, withTimeout } from "./client.js";

interface Speaker {
  name: string;
  styles: { id: number }[];
}

export function voicevoxClient(baseUrl: string, speaker: number): TtsClient {
  return {
    async prepare(signal) {
      const res = await fetch(`${baseUrl}/initialize_speaker?speaker=${speaker}&skip_reinit=true`, {
        method: "POST",
        signal: withTimeout(signal),
      });
      await ensureOk(res, "VOICEVOX speaker initialization");
    },

    async credit(signal) {
      const res = await fetch(`${baseUrl}/speakers`, { signal: withTimeout(signal) });
      await ensureOk(res, "VOICEVOX speaker lookup");
      const speakers = (await res.json()) as Speaker[];
      const found = speakers.find((s) => s.styles.some((style) => style.id === speaker));
      if (!found) {
        throw new Error(`VOICEVOX has no style with id ${speaker}`);
      }
      return `VOICEVOX:${found.name}`;
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
