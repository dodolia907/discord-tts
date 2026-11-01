import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Guild } from "discord.js";
import type { VoiceLink } from "./session.js";

const CONNECT_TIMEOUT_MS = 30_000;
const RECONNECT_GRACE_MS = 5_000;

export async function connectVoice(
  guild: Guild,
  channelId: string,
  onLost: () => void,
  signal: AbortSignal,
): Promise<VoiceLink> {
  const connection = joinVoiceChannel({
    guildId: guild.id,
    channelId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  const destroy = () => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
  };

  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
    );
  } catch (error) {
    destroy();
    throw error;
  }

  // Discord also reports a move between channels or a region change as Disconnected, and those recover by themselves.
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    Promise.race([
      entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
      entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
    ]).catch(destroy);
  });
  connection.on(VoiceConnectionStatus.Destroyed, onLost);

  const player = createAudioPlayer();
  connection.subscribe(player);

  return {
    destroy,
    play(wav, playSignal) {
      return new Promise<void>((resolve, reject) => {
        const finish = (settle: () => void) => {
          player.off(AudioPlayerStatus.Idle, onIdle);
          player.off("error", onError);
          playSignal.removeEventListener("abort", onAbort);
          settle();
        };
        const onIdle = () => finish(resolve);
        const onError = (error: Error) => finish(() => reject(error));
        const onAbort = () => {
          player.stop(true);
          finish(resolve);
        };

        player.once(AudioPlayerStatus.Idle, onIdle);
        player.once("error", onError);
        playSignal.addEventListener("abort", onAbort, { once: true });
        // Arbitrary input goes through ffmpeg, which encodes to Opus, so no separate encoder is needed.
        player.play(createAudioResource(Readable.from(wav), { inputType: StreamType.Arbitrary }));
      });
    },
  };
}
