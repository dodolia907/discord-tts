import { type EngineName, isEngineName } from "./engines.js";

export interface Config {
  discordToken: string;
  namespace: string;
  maxSessions: number;
  defaultEngine: EngineName;
  openjtalkImage: string;
  voicevoxImage: string;
  voicevoxSpeaker: number;
  /** Shown as "Playing ..." on the bot's profile. Null shows nothing. */
  activityName: string | null;
  /** Where the guilds' dictionaries are kept. */
  dataDir: string;
  /** The bot's own Pod. TTS Pods point their ownerReference at it. */
  owner: { name: string; uid: string };
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function integer(env: Env, key: string, fallback: number, min: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${key} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  const defaultEngine = env.DEFAULT_ENGINE || "openjtalk";
  if (!isEngineName(defaultEngine)) {
    throw new Error(`DEFAULT_ENGINE is invalid: "${defaultEngine}"`);
  }
  return {
    discordToken: required(env, "DISCORD_TOKEN"),
    namespace: required(env, "POD_NAMESPACE"),
    maxSessions: integer(env, "MAX_SESSIONS", 2, 1),
    defaultEngine,
    openjtalkImage: required(env, "OPENJTALK_IMAGE"),
    voicevoxImage: required(env, "VOICEVOX_IMAGE"),
    voicevoxSpeaker: integer(env, "VOICEVOX_SPEAKER", 3, 0),
    activityName: env.ACTIVITY_NAME?.trim() || null,
    dataDir: env.DATA_DIR || "/data",
    owner: { name: required(env, "POD_NAME"), uid: required(env, "POD_UID") },
  };
}
