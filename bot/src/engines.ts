import type { TtsClient } from "./tts/client.js";
import { openJTalkClient } from "./tts/openjtalk.js";
import { voicevoxClient } from "./tts/voicevox.js";

export const ENGINE_NAMES = ["openjtalk", "voicevox"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export function isEngineName(value: string): value is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(value);
}

export interface Engine {
  name: EngineName;
  label: string;
  image: string;
  command?: string[];
  port: number;
  readinessPath: string;
  resources: {
    requests: { cpu: string; memory: string };
    limits: { cpu: string; memory: string };
  };
  /** Includes pulling the image, which can take minutes on a cold node. */
  startTimeoutMs: number;
  createClient(baseUrl: string): TtsClient;
}

export function createEngines(opts: {
  openjtalkImage: string;
  voicevoxImage: string;
  voicevoxSpeaker: number;
}): Record<EngineName, Engine> {
  return {
    openjtalk: {
      name: "openjtalk",
      label: "Open JTalk",
      image: opts.openjtalkImage,
      port: 8080,
      readinessPath: "/healthz",
      resources: {
        requests: { cpu: "50m", memory: "64Mi" },
        limits: { cpu: "500m", memory: "128Mi" },
      },
      startTimeoutMs: 60_000 * 3,
      createClient: openJTalkClient,
    },
    voicevox: {
      name: "voicevox",
      label: "VOICEVOX",
      image: opts.voicevoxImage,
      // The image's entrypoint uses gosu to switch users, which needs root.
      command: ["/opt/voicevox_engine/run", "--host", "0.0.0.0"],
      port: 50021,
      readinessPath: "/version",
      // Measured at 335 MB after loading one speaker and synthesizing.
      resources: {
        requests: { cpu: "500m", memory: "512Mi" },
        limits: { cpu: "2", memory: "1Gi" },
      },
      startTimeoutMs: 60_000 * 10,
      createClient: (baseUrl) => voicevoxClient(baseUrl, opts.voicevoxSpeaker),
    },
  };
}
