export interface TtsClient {
  /** Loads whatever the engine needs so that the first message is not slow. */
  prepare(signal: AbortSignal): Promise<void>;
  /** Returns WAV audio. */
  synthesize(text: string, signal: AbortSignal): Promise<Buffer>;
  /** Attribution the engine's terms require to be displayed, if any. */
  credit(signal: AbortSignal): Promise<string | null>;
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
