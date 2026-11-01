import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineName } from "./engines.js";
import { FAILURES_BEFORE_RECOVERY, MAX_QUEUE, type SessionDeps, SessionManager, UserFacingError } from "./session.js";
import type { TtsClient, Voice } from "./tts/client.js";

const GUILD = "g1";
const CHANNEL = "c1";
const join = { guildId: GUILD, channelId: CHANNEL, engine: "openjtalk" as EngineName };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<SessionDeps> = {}) {
  const tts = {
    prepare: vi.fn(async () => {}),
    credit: vi.fn(async () => null as string | null),
    synthesize: vi.fn(async (text: string): Promise<Buffer> => Buffer.from(text)),
    voices: vi.fn(async (): Promise<Voice[]> => [
      { id: 3, label: "ずんだもん(ノーマル)" },
      { id: 2, label: "四国めたん(ノーマル)" },
    ]),
    selectVoice: vi.fn(async (_id: number, _signal: AbortSignal) => {}),
  } satisfies TtsClient;
  const engine = { name: "openjtalk", createClient: () => tts } as unknown as Engine;
  const voice = {
    play: vi.fn(async (_wav: Buffer, _signal: AbortSignal) => {}),
    destroy: vi.fn(),
  };
  let podCount = 0;
  const pods = {
    start: vi.fn(async (_g: string, _e: Engine, _s: AbortSignal) => {
      podCount += 1;
      return { name: `pod-${podCount}`, baseUrl: "http://pod" };
    }),
    delete: vi.fn(async (_name: string) => {}),
    restartCount: vi.fn(async (_name: string) => 0),
  };
  let lost = () => {};
  const deps: SessionDeps = {
    pods,
    engines: { openjtalk: engine, voicevox: engine },
    connectVoice: vi.fn(async (_g, _c, onLost) => {
      lost = onLost;
      return voice;
    }),
    notify: vi.fn(),
    log: vi.fn(),
    maxSessions: 2,
    ...overrides,
  };
  return { manager: new SessionManager(deps), deps, pods, tts, voice, triggerLost: () => lost() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SessionManager", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("starts the Pod before connecting to voice", async () => {
    const order: string[] = [];
    ctx.pods.start.mockImplementationOnce(async () => {
      order.push("pod");
      return { name: "pod", baseUrl: "http://pod" };
    });
    const local = setup({
      pods: ctx.pods,
      connectVoice: async () => {
        order.push("voice");
        return ctx.voice;
      },
    });

    await local.manager.join(join);

    expect(order).toEqual(["pod", "voice"]);
  });

  it("returns the engine's credit", async () => {
    ctx.tts.credit.mockResolvedValue("VOICEVOX:ずんだもん");
    await expect(ctx.manager.join(join)).resolves.toBe("VOICEVOX:ずんだもん");
  });

  it("rejects a second join in the same guild, even while starting", async () => {
    const pending = deferred<{ name: string; baseUrl: string }>();
    ctx.pods.start.mockReturnValueOnce(pending.promise);
    const first = ctx.manager.join(join);

    await expect(ctx.manager.join(join)).rejects.toBeInstanceOf(UserFacingError);

    pending.resolve({ name: "pod", baseUrl: "http://pod" });
    await first;
    expect(ctx.pods.start).toHaveBeenCalledTimes(1);
  });

  it("counts starting sessions towards the limit", async () => {
    ctx.pods.start.mockReturnValue(new Promise(() => {}));
    void ctx.manager.join({ ...join, guildId: "a" });
    void ctx.manager.join({ ...join, guildId: "b" });

    await expect(ctx.manager.join({ ...join, guildId: "c" })).rejects.toBeInstanceOf(UserFacingError);
  });

  it("frees the slot when the Pod cannot start", async () => {
    ctx.pods.start.mockRejectedValueOnce(new UserFacingError("no capacity"));

    await expect(ctx.manager.join(join)).rejects.toThrow("no capacity");
    expect(ctx.pods.delete).not.toHaveBeenCalled();

    await expect(ctx.manager.join(join)).resolves.toBeNull();
  });

  it("deletes the Pod when connecting to voice fails", async () => {
    const local = setup({ connectVoice: async () => Promise.reject(new Error("voice down")) });

    await expect(local.manager.join(join)).rejects.toThrow("voice down");

    expect(local.pods.delete).toHaveBeenCalledWith("pod-1");
    expect(await local.manager.leave(GUILD)).toBe(false);
  });

  it("leaving during startup aborts it and connects nothing", async () => {
    const pending = deferred<{ name: string; baseUrl: string }>();
    let signal: AbortSignal | undefined;
    ctx.pods.start.mockImplementationOnce((_g, _e, s) => {
      signal = s;
      return pending.promise;
    });
    const joined = ctx.manager.join(join);
    await flush();

    const left = ctx.manager.leave(GUILD);
    expect(signal?.aborted).toBe(true);
    await left;

    pending.reject(new DOMException("aborted", "AbortError"));
    await expect(joined).rejects.toThrow("aborted");
    expect(ctx.deps.connectVoice).not.toHaveBeenCalled();
  });

  it("deletes a Pod that became Ready just as the session was closed", async () => {
    const pending = deferred<{ name: string; baseUrl: string }>();
    ctx.pods.start.mockReturnValueOnce(pending.promise);
    const joined = ctx.manager.join(join);
    await flush();

    await ctx.manager.leave(GUILD);
    pending.resolve({ name: "late-pod", baseUrl: "http://pod" });

    await expect(joined).rejects.toThrow();
    expect(ctx.pods.delete).toHaveBeenCalledWith("late-pod");
  });

  it("destroys a voice link that connected just as the session was closed", async () => {
    const pending = deferred<typeof ctx.voice>();
    const local = setup({ connectVoice: () => pending.promise });
    const joined = local.manager.join(join);
    await flush();

    const left = local.manager.leave(GUILD);
    pending.resolve(local.voice);

    await expect(joined).rejects.toThrow();
    await left;
    expect(local.voice.destroy).toHaveBeenCalled();
  });

  it.each([
    ["/leave", (c: typeof ctx) => c.manager.leave(GUILD)],
    ["being disconnected", (c: typeof ctx) => c.manager.handleSelfVoiceState(GUILD, null)],
    ["being moved", (c: typeof ctx) => c.manager.handleSelfVoiceState(GUILD, "other")],
    ["everyone leaving", (c: typeof ctx) => c.manager.handleHumanCount(GUILD, CHANNEL, 0)],
    ["the voice link dying", (c: typeof ctx) => c.triggerLost()],
    ["shutdown", (c: typeof ctx) => c.manager.closeAll()],
  ])("%s disconnects and deletes the Pod", async (_name, trigger) => {
    await ctx.manager.join(join);

    await trigger(ctx);
    await flush();

    expect(ctx.voice.destroy).toHaveBeenCalledTimes(1);
    expect(ctx.pods.delete).toHaveBeenCalledTimes(1);
    expect(ctx.pods.delete).toHaveBeenCalledWith("pod-1");
    await expect(ctx.manager.leave(GUILD)).resolves.toBe(false);
  });

  it("close is idempotent across overlapping triggers", async () => {
    await ctx.manager.join(join);

    ctx.manager.handleHumanCount(GUILD, CHANNEL, 0);
    ctx.manager.handleSelfVoiceState(GUILD, null);
    ctx.triggerLost();
    await ctx.manager.leave(GUILD);

    expect(ctx.voice.destroy).toHaveBeenCalledTimes(1);
    expect(ctx.pods.delete).toHaveBeenCalledTimes(1);
  });

  it("ignores events that do not end the session", async () => {
    await ctx.manager.join(join);

    ctx.manager.handleSelfVoiceState(GUILD, CHANNEL);
    ctx.manager.handleHumanCount(GUILD, CHANNEL, 1);
    ctx.manager.handleHumanCount(GUILD, "other", 0);
    await flush();

    expect(ctx.pods.delete).not.toHaveBeenCalled();
  });

  it("does not treat the not-yet-connected bot as disconnected", async () => {
    const pending = deferred<{ name: string; baseUrl: string }>();
    ctx.pods.start.mockReturnValueOnce(pending.promise);
    const joined = ctx.manager.join(join);

    ctx.manager.handleSelfVoiceState(GUILD, null);
    pending.resolve({ name: "pod", baseUrl: "http://pod" });

    await joined;
    expect(ctx.pods.delete).not.toHaveBeenCalled();
  });

  it("logs a failed Pod deletion and still frees the slot", async () => {
    ctx.pods.delete.mockRejectedValueOnce(new Error("api down"));
    await ctx.manager.join(join);

    await ctx.manager.leave(GUILD);

    expect(ctx.deps.log).toHaveBeenCalledWith(expect.stringContaining("pod-1"), expect.any(Error));
    await expect(ctx.manager.join(join)).resolves.toBeNull();
  });
});

describe("restart notices", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("announces a container restart once", async () => {
    const restartCount = vi.fn(async () => 1);
    const base = setup();
    const { manager, deps } = setup({
      pods: { ...base.pods, restartCount },
      podWatchIntervalMs: 1,
    });
    await manager.join(join);

    await sleep(20);

    expect(restartCount.mock.calls.length).toBeGreaterThan(1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith(CHANNEL, expect.stringContaining("再起動しました"));
    await manager.closeAll();
  });

  it("stays quiet without a restart and stops watching on close", async () => {
    const restartCount = vi.fn(async () => 0);
    const base = setup();
    const { manager, deps } = setup({
      pods: { ...base.pods, restartCount },
      podWatchIntervalMs: 1,
    });
    await manager.join(join);
    await sleep(5);

    await manager.leave(GUILD);
    const calls = restartCount.mock.calls.length;
    await sleep(10);

    expect(deps.notify).not.toHaveBeenCalled();
    expect(restartCount.mock.calls.length).toBe(calls);
  });

  it("logs a failed check and keeps the session", async () => {
    const base = setup();
    const { manager, deps } = setup({
      pods: { ...base.pods, restartCount: vi.fn().mockRejectedValue(new Error("api down")) },
      podWatchIntervalMs: 1,
    });
    await manager.join(join);

    await sleep(5);

    expect(deps.log).toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    await manager.closeAll();
  });

  it("announces recreating the Pod", async () => {
    const { manager, tts, deps } = setup();
    await manager.join(join);
    for (let i = 0; i < FAILURES_BEFORE_RECOVERY; i += 1) {
      tts.synthesize.mockRejectedValueOnce(new Error("boom"));
      manager.handleMessage(GUILD, CHANNEL, "", `失敗${i}`);
    }
    await flush();
    await flush();

    expect(vi.mocked(deps.notify).mock.calls.map(([, message]) => message)).toEqual([
      expect.stringContaining("再起動しています"),
      expect.stringContaining("再開"),
    ]);
  });

  it("tells every session when the bot shuts down", async () => {
    const { manager, deps } = setup();
    await manager.join(join);

    await manager.closeAll("再起動します");

    expect(deps.notify).toHaveBeenCalledWith(CHANNEL, "再起動します");
  });
});

describe("changing the voice", () => {
  it("selects the matching voice and returns its credit", async () => {
    const { manager, tts } = setup();
    await manager.join(join);
    tts.credit.mockResolvedValue("VOICEVOX:四国めたん");

    await expect(manager.changeVoice(GUILD, "2")).resolves.toEqual({
      label: "四国めたん(ノーマル)",
      credit: "VOICEVOX:四国めたん",
    });
    expect(tts.selectVoice).toHaveBeenCalledWith(2, expect.anything());
  });

  it("rejects a voice that does not exist", async () => {
    const { manager, tts } = setup();
    await manager.join(join);

    await expect(manager.changeVoice(GUILD, "いない")).rejects.toBeInstanceOf(UserFacingError);
    expect(tts.selectVoice).not.toHaveBeenCalled();
  });

  it("explains that an engine with one voice cannot change", async () => {
    const { manager, tts } = setup();
    tts.voices.mockResolvedValue([]);
    await manager.join(join);

    await expect(manager.changeVoice(GUILD, "2")).rejects.toThrow("VOICEVOX");
  });

  it("requires a session", async () => {
    const { manager } = setup();

    await expect(manager.changeVoice(GUILD, "2")).rejects.toBeInstanceOf(UserFacingError);
    await expect(manager.voices(GUILD)).resolves.toEqual([]);
  });

  it("does not offer or change voices while starting", async () => {
    const { manager, pods } = setup();
    pods.start.mockReturnValue(new Promise(() => {}));
    void manager.join(join);
    await flush();

    await expect(manager.voices(GUILD)).resolves.toEqual([]);
    await expect(manager.changeVoice(GUILD, "2")).rejects.toBeInstanceOf(UserFacingError);
  });

  it("restores the chosen voice after the Pod is recreated", async () => {
    const { manager, tts, pods } = setup();
    await manager.join(join);
    await manager.changeVoice(GUILD, "2");
    tts.selectVoice.mockClear();
    for (let i = 0; i < FAILURES_BEFORE_RECOVERY; i += 1) {
      tts.synthesize.mockRejectedValueOnce(new Error("boom"));
      manager.handleMessage(GUILD, CHANNEL, "", `失敗${i}`);
    }
    await flush();
    await flush();

    expect(pods.start).toHaveBeenCalledTimes(2);
    expect(tts.selectVoice).toHaveBeenCalledWith(2, expect.anything());
  });
});

describe("reading messages", () => {
  it("reads the author's name before the message", async () => {
    const { manager, tts } = setup();
    await manager.join(join);

    manager.handleMessage(GUILD, CHANNEL, "ぽんた", "こんにちは");
    await flush();

    expect(tts.synthesize).toHaveBeenCalledWith("ぽんた、こんにちは", expect.anything());
  });

  it("reads the session's channel in order and ignores the rest", async () => {
    const { manager, voice } = setup();
    await manager.join(join);

    manager.handleMessage(GUILD, CHANNEL, "", "一");
    manager.handleMessage(GUILD, "other", "", "別チャンネル");
    manager.handleMessage("other", CHANNEL, "", "別サーバー");
    manager.handleMessage(GUILD, CHANNEL, "", "<:emoji:1>");
    manager.handleMessage(GUILD, CHANNEL, "", "二");
    await flush();

    expect(voice.play.mock.calls.map(([wav]) => wav.toString())).toEqual(["一", "二"]);
  });

  it("ignores messages sent during startup", async () => {
    const pending = deferred<{ name: string; baseUrl: string }>();
    const { manager, pods, voice } = setup();
    pods.start.mockReturnValueOnce(pending.promise);
    const joined = manager.join(join);

    manager.handleMessage(GUILD, CHANNEL, "", "早すぎる");
    pending.resolve({ name: "pod", baseUrl: "http://pod" });
    await joined;
    await flush();

    expect(voice.play).not.toHaveBeenCalled();
  });

  it("drops the oldest entries when the queue overflows", async () => {
    const { manager, tts, voice } = setup();
    const gate = deferred<Buffer>();
    tts.synthesize.mockReturnValueOnce(gate.promise);
    await manager.join(join);

    const total = MAX_QUEUE + 3;
    for (let i = 0; i < total; i += 1) {
      manager.handleMessage(GUILD, CHANNEL, "", `m${i}`);
    }
    gate.resolve(Buffer.from("m0"));
    await flush();
    await flush();

    const played = voice.play.mock.calls.map(([wav]) => wav.toString());
    expect(played).toHaveLength(MAX_QUEUE + 1);
    expect(played[0]).toBe("m0");
    expect(played[1]).toBe("m3");
    expect(played.at(-1)).toBe(`m${total - 1}`);
  });

  it("skips a failed message and continues", async () => {
    const { manager, tts, voice, pods } = setup();
    tts.synthesize.mockRejectedValueOnce(new Error("boom"));
    await manager.join(join);

    manager.handleMessage(GUILD, CHANNEL, "", "失敗");
    manager.handleMessage(GUILD, CHANNEL, "", "成功");
    await flush();

    expect(voice.play.mock.calls.map(([wav]) => wav.toString())).toEqual(["成功"]);
    expect(pods.start).toHaveBeenCalledTimes(1);
  });

  it("recreates the Pod after repeated failures and keeps reading", async () => {
    const { manager, tts, voice, pods } = setup();
    for (let i = 0; i < FAILURES_BEFORE_RECOVERY; i += 1) {
      tts.synthesize.mockRejectedValueOnce(new Error("boom"));
    }
    await manager.join(join);

    for (let i = 0; i < FAILURES_BEFORE_RECOVERY; i += 1) {
      manager.handleMessage(GUILD, CHANNEL, "", `失敗${i}`);
    }
    manager.handleMessage(GUILD, CHANNEL, "", "復旧後");
    await flush();
    await flush();

    expect(pods.delete).toHaveBeenCalledWith("pod-1");
    expect(pods.start).toHaveBeenCalledTimes(2);
    expect(voice.play.mock.calls.map(([wav]) => wav.toString())).toEqual(["復旧後"]);
  });

  it("closes and notifies when recovery does not help", async () => {
    const { manager, tts, deps, pods, voice } = setup();
    tts.synthesize.mockRejectedValue(new Error("boom"));
    await manager.join(join);

    for (let i = 0; i < FAILURES_BEFORE_RECOVERY * 2; i += 1) {
      manager.handleMessage(GUILD, CHANNEL, "", `失敗${i}`);
    }
    await flush();
    await flush();

    expect(pods.start).toHaveBeenCalledTimes(2);
    expect(pods.delete).toHaveBeenCalledWith("pod-2");
    expect(voice.destroy).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith(CHANNEL, expect.stringContaining("終了"));
    await expect(manager.leave(GUILD)).resolves.toBe(false);
  });

  it("closes when the Pod cannot be recreated", async () => {
    const { manager, tts, pods, deps } = setup();
    tts.synthesize.mockRejectedValue(new Error("boom"));
    await manager.join(join);
    pods.start.mockRejectedValueOnce(new Error("no capacity"));

    for (let i = 0; i < FAILURES_BEFORE_RECOVERY; i += 1) {
      manager.handleMessage(GUILD, CHANNEL, "", `失敗${i}`);
    }
    await flush();
    await flush();

    expect(deps.notify).toHaveBeenCalledWith(CHANNEL, expect.stringContaining("終了"));
    await expect(manager.leave(GUILD)).resolves.toBe(false);
  });

  it("stops reading on close", async () => {
    const { manager, tts, voice } = setup();
    const gate = deferred<Buffer>();
    tts.synthesize.mockReturnValueOnce(gate.promise);
    await manager.join(join);

    manager.handleMessage(GUILD, CHANNEL, "", "一");
    manager.handleMessage(GUILD, CHANNEL, "", "二");
    await manager.leave(GUILD);
    gate.reject(new DOMException("aborted", "AbortError"));
    await flush();

    expect(voice.play).not.toHaveBeenCalled();
    expect(tts.synthesize).toHaveBeenCalledTimes(1);
  });
});
