import type { Engine, EngineName } from "./engines.js";
import { toUtterance } from "./text.js";
import { matchVoices, type TtsClient, type Voice } from "./tts/client.js";

export const MAX_QUEUE = 20;
export const FAILURES_BEFORE_RECOVERY = 3;

export interface RunningPod {
  name: string;
  baseUrl: string;
}

export interface PodController {
  /** Resolves once the Pod is Ready. Leaves no Pod behind when it rejects. */
  start(guildId: string, engine: Engine, signal: AbortSignal): Promise<RunningPod>;
  delete(name: string): Promise<void>;
}

export interface VoiceLink {
  play(wav: Buffer, signal: AbortSignal): Promise<void>;
  destroy(): void;
}

export interface SessionDeps {
  pods: PodController;
  engines: Record<EngineName, Engine>;
  /** Leaves no connection behind when it rejects. `onLost` fires if the link later dies. */
  connectVoice(guildId: string, channelId: string, onLost: () => void, signal: AbortSignal): Promise<VoiceLink>;
  notify(channelId: string, message: string): void;
  log(message: string, error?: unknown): void;
  maxSessions: number;
}

/** A failure whose message is meant for the Discord user. */
export class UserFacingError extends Error {}

type JoinRequest = { guildId: string; channelId: string; engine: EngineName };

class Session {
  readonly channelId: string;
  private readonly abort = new AbortController();
  private readonly queue: string[] = [];
  private pod: RunningPod | null = null;
  private tts: TtsClient | null = null;
  private voice: VoiceLink | null = null;
  private selectedVoice: number | null = null;
  private processing = false;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly request: JoinRequest,
    private readonly deps: SessionDeps,
    private readonly onClosed: () => void,
  ) {
    this.channelId = request.channelId;
  }

  get connected(): boolean {
    return this.voice !== null && this.closing === null;
  }

  /** Returns the attribution to display, if any. */
  async start(): Promise<string | null> {
    const { guildId, channelId, engine: engineName } = this.request;
    const engine = this.deps.engines[engineName];
    const { signal } = this.abort;
    try {
      await this.startPod(engine);
      const credit = await this.tts!.credit(signal);
      await this.tts!.prepare(signal);
      signal.throwIfAborted();

      const voice = await this.deps.connectVoice(guildId, channelId, () => void this.close(), signal);
      if (signal.aborted) {
        voice.destroy();
        signal.throwIfAborted();
      }
      this.voice = voice;
      return credit;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Returns nothing until the session can answer, because autocomplete must not fail loudly. */
  async voices(): Promise<Voice[]> {
    return this.connected && this.tts ? this.tts.voices(this.abort.signal) : [];
  }

  async changeVoice(query: string): Promise<{ label: string; credit: string | null }> {
    const tts = this.tts;
    if (!this.connected || !tts) {
      throw new UserFacingError("読み上げの準備中です。しばらくしてからお試しください。");
    }
    const { signal } = this.abort;
    const voices = await tts.voices(signal);
    if (voices.length === 0) {
      throw new UserFacingError("このエンジンでは声を変更できません。`/join engine:VOICEVOX` をお使いください。");
    }
    const voice = matchVoices(voices, query)[0];
    if (!voice) {
      throw new UserFacingError(`「${query}」に一致する声が見つかりません。`);
    }
    await tts.selectVoice(voice.id, signal);
    this.selectedVoice = voice.id;
    return { label: voice.label, credit: await tts.credit(signal) };
  }

  enqueue(author: string, content: string): void {
    if (!this.connected) {
      return;
    }
    const text = toUtterance(author, content);
    if (!text) {
      return;
    }
    this.queue.push(text);
    if (this.queue.length > MAX_QUEUE) {
      this.queue.shift();
    }
    if (!this.processing) {
      void this.processQueue();
    }
  }

  close(notice?: string): Promise<void> {
    this.closing ??= this.shutdown(notice);
    return this.closing;
  }

  private async shutdown(notice?: string): Promise<void> {
    this.abort.abort();
    this.queue.length = 0;
    this.voice?.destroy();
    this.voice = null;
    if (notice) {
      this.deps.notify(this.channelId, notice);
    }
    try {
      await this.deletePod();
    } finally {
      this.onClosed();
    }
  }

  private async startPod(engine: Engine): Promise<void> {
    const { signal } = this.abort;
    const pod = await this.deps.pods.start(this.request.guildId, engine, signal);
    // shutdown() has already run and cannot see this Pod, so it has to be removed here.
    if (signal.aborted) {
      await this.deletePodNamed(pod.name);
      signal.throwIfAborted();
    }
    this.pod = pod;
    this.tts = engine.createClient(pod.baseUrl);
  }

  private async deletePod(): Promise<void> {
    const pod = this.pod;
    this.pod = null;
    this.tts = null;
    if (pod) {
      await this.deletePodNamed(pod.name);
    }
  }

  private async deletePodNamed(name: string): Promise<void> {
    try {
      await this.deps.pods.delete(name);
    } catch (error) {
      this.deps.log(`failed to delete Pod ${name}`, error);
    }
  }

  private async processQueue(): Promise<void> {
    const { signal } = this.abort;
    let failures = 0;
    let recovered = false;
    this.processing = true;
    try {
      while (this.queue.length > 0 && !signal.aborted) {
        const text = this.queue.shift()!;
        let wav: Buffer;
        try {
          wav = await this.tts!.synthesize(text, signal);
          failures = 0;
          recovered = false;
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          failures += 1;
          this.deps.log(`synthesis failed (${failures})`, error);
          if (failures >= FAILURES_BEFORE_RECOVERY) {
            failures = 0;
            if (recovered || !(await this.recoverPod())) {
              void this.close("音声合成Podが復旧しなかったため、読み上げを終了しました。");
              return;
            }
            recovered = true;
          }
          continue;
        }
        try {
          await this.voice?.play(wav, signal);
        } catch (error) {
          if (!signal.aborted) {
            this.deps.log("playback failed", error);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async recoverPod(): Promise<boolean> {
    try {
      await this.deletePod();
      const engine = this.deps.engines[this.request.engine];
      await this.startPod(engine);
      await this.tts!.prepare(this.abort.signal);
      if (this.selectedVoice !== null) {
        await this.tts!.selectVoice(this.selectedVoice, this.abort.signal);
      }
      return true;
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.deps.log("failed to recreate the TTS Pod", error);
      }
      return false;
    }
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: SessionDeps) {}

  /** Starts a session and returns the attribution to display, if any. */
  async join(request: JoinRequest): Promise<string | null> {
    if (this.sessions.has(request.guildId)) {
      throw new UserFacingError("このサーバーでは既に読み上げ中か、処理中です。");
    }
    if (this.sessions.size >= this.deps.maxSessions) {
      throw new UserFacingError("同時に読み上げできる上限に達しています。しばらくしてからお試しください。");
    }
    const session = new Session(request, this.deps, () => this.sessions.delete(request.guildId));
    this.sessions.set(request.guildId, session);
    return session.start();
  }

  /** Returns false when the guild has no session. */
  async leave(guildId: string): Promise<boolean> {
    const session = this.sessions.get(guildId);
    if (!session) {
      return false;
    }
    await session.close();
    return true;
  }

  handleMessage(guildId: string, channelId: string, author: string, content: string): void {
    const session = this.sessions.get(guildId);
    if (session?.channelId === channelId) {
      session.enqueue(author, content);
    }
  }

  async voices(guildId: string): Promise<Voice[]> {
    return (await this.sessions.get(guildId)?.voices()) ?? [];
  }

  async changeVoice(guildId: string, query: string): Promise<{ label: string; credit: string | null }> {
    const session = this.sessions.get(guildId);
    if (!session) {
      throw new UserFacingError("読み上げ中ではありません。先に `/join` を実行してください。");
    }
    return session.changeVoice(query);
  }

  /** The bot was disconnected or moved by someone else. */
  handleSelfVoiceState(guildId: string, channelId: string | null): void {
    const session = this.sessions.get(guildId);
    if (session?.connected && session.channelId !== channelId) {
      void session.close();
    }
  }

  handleHumanCount(guildId: string, channelId: string, humans: number): void {
    const session = this.sessions.get(guildId);
    if (session?.channelId === channelId && humans === 0) {
      void session.close();
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
  }
}
