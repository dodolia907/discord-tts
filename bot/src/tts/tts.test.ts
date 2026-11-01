import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openJTalkClient } from "./openjtalk.js";
import { voicevoxClient } from "./voicevox.js";

type Reply = { status?: number; body: string };
type Seen = { method: string; url: string; body: string };

let server: Server | undefined;

async function serve(routes: Record<string, Reply>): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  };
  server = createServer(async (req, res) => {
    seen.push({ method: req.method!, url: req.url!, body: await readBody(req) });
    const reply = routes[req.url!.split("?")[0]!];
    res.statusCode = reply?.status ?? (reply ? 200 : 404);
    res.end(reply?.body ?? "");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

afterEach(() => {
  server?.close();
  server = undefined;
});

const signal = new AbortController().signal;

describe("openJTalkClient", () => {
  it("posts the text as JSON and returns the audio", async () => {
    const { url, seen } = await serve({ "/synthesize": { body: "RIFF" } });

    const wav = await openJTalkClient(url).synthesize("こんにちは", signal);

    expect(wav.toString()).toBe("RIFF");
    expect(JSON.parse(seen[0]!.body)).toEqual({ text: "こんにちは" });
  });

  it("throws on an error response", async () => {
    const { url } = await serve({ "/synthesize": { status: 500, body: "" } });
    await expect(openJTalkClient(url).synthesize("a", signal)).rejects.toThrow("HTTP 500");
  });
});

describe("voicevoxClient", () => {
  it("passes the audio query to the synthesis endpoint", async () => {
    const { url, seen } = await serve({
      "/audio_query": { body: '{"q":1}' },
      "/synthesis": { body: "RIFF" },
    });

    const wav = await voicevoxClient(url, 3).synthesize("こんにちは&speaker=9", signal);

    expect(wav.toString()).toBe("RIFF");
    const query = new URL(seen[0]!.url, url).searchParams;
    expect(query.get("text")).toBe("こんにちは&speaker=9");
    expect(query.get("speaker")).toBe("3");
    expect(seen[1]!.url).toBe("/synthesis?speaker=3");
    expect(seen[1]!.body).toBe('{"q":1}');
  });

  it("resolves the credit from the style id", async () => {
    const { url } = await serve({
      "/speakers": {
        body: JSON.stringify([
          { name: "四国めたん", styles: [{ id: 2 }] },
          { name: "ずんだもん", styles: [{ id: 1 }, { id: 3 }] },
        ]),
      },
    });

    await expect(voicevoxClient(url, 3).credit(signal)).resolves.toBe("VOICEVOX:ずんだもん");
    await expect(voicevoxClient(url, 99).credit(signal)).rejects.toThrow("no style");
  });
});
