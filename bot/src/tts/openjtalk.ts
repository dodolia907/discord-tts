import { ensureOk, type TtsClient, withTimeout } from "./client.js";

export function openJTalkClient(baseUrl: string): TtsClient {
  return {
    async prepare() {},
    async credit() {
      return null;
    },
    async voices() {
      return [];
    },
    async selectVoice() {
      throw new Error("Open JTalk has only one voice");
    },
    async synthesize(text, signal) {
      const res = await fetch(`${baseUrl}/synthesize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: withTimeout(signal),
      });
      await ensureOk(res, "open_jtalk synthesis");
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
