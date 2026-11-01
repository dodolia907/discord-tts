export interface Voice {
  id: number;
  label: string;
}

export interface TtsClient {
  /** Loads whatever the engine needs so that the first message is not slow. */
  prepare(signal: AbortSignal): Promise<void>;
  /** Returns WAV audio. */
  synthesize(text: string, signal: AbortSignal): Promise<Buffer>;
  /** Attribution the engine's terms require to be displayed for the current voice, if any. */
  credit(signal: AbortSignal): Promise<string | null>;
  /** The selectable voices. Empty means the engine has only one voice. */
  voices(signal: AbortSignal): Promise<Voice[]>;
  selectVoice(id: number, signal: AbortSignal): Promise<void>;
}

export const SYNTHESIS_TIMEOUT_MS = 60_000;

export function withTimeout(signal: AbortSignal, ms = SYNTHESIS_TIMEOUT_MS): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

export async function ensureOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) {
    throw new Error(`${what} failed with HTTP ${res.status}`);
  }
  return res;
}

/** Voices matching what the user typed, best match first. */
export function matchVoices(voices: Voice[], query: string): Voice[] {
  const needle = query.trim().toLowerCase();
  const byId = voices.filter((voice) => String(voice.id) === needle);
  return byId.length > 0 ? byId : voices.filter((voice) => voice.label.toLowerCase().includes(needle));
}
