import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { ChannelType, Client, Events, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import { commandDefinitions, handleCommand, syncCommands } from "./commands.js";
import { loadConfig } from "./config.js";
import { createEngines } from "./engines.js";
import { KubernetesPods } from "./k8s.js";
import { SessionManager } from "./session.js";
import { connectVoice } from "./voice.js";

const SHUTDOWN_TIMEOUT_MS = 20_000;

function log(message: string, error?: unknown): void {
  if (error === undefined) {
    console.log(message);
  } else {
    console.error(message, error);
  }
}

const config = loadConfig();
const engines = createEngines(config);

const kubeConfig = new KubeConfig();
kubeConfig.loadFromCluster();
const pods = new KubernetesPods(kubeConfig.makeApiClient(CoreV1Api), config.namespace, config.owner, log);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const manager = new SessionManager({
  pods,
  engines,
  maxSessions: config.maxSessions,
  log,
  async connectVoice(guildId, channelId, onLost, signal) {
    const guild = await client.guilds.fetch(guildId);
    return connectVoice(guild, channelId, onLost, signal);
  },
  notify(channelId, message) {
    const channel = client.channels.cache.get(channelId);
    if (channel?.isSendable()) {
      channel.send(message).catch((error: unknown) => log("failed to send a notice", error));
    }
  },
});

/** Clears what a previous run left behind: its Pods, and voice connections Discord still holds. */
async function cleanUpPreviousRun(c: Client<true>): Promise<void> {
  await pods.deleteAll();
  for (const guild of c.guilds.cache.values()) {
    if (guild.voiceStates.cache.get(c.user.id)?.channelId) {
      guild.shard.send({
        op: 4,
        d: { guild_id: guild.id, channel_id: null, self_mute: false, self_deaf: false },
      });
    }
  }
}

function countHumans(channel: VoiceBasedChannel): number {
  return channel.members.filter((member) => !member.user.bot).size;
}

client.once(Events.ClientReady, async (c) => {
  try {
    await cleanUpPreviousRun(c);
    await syncCommands(c.application, c.guilds.cache.values(), commandDefinitions(engines), log);
    log(`ready as ${c.user.tag}`);
  } catch (error) {
    log("startup failed", error);
    process.exit(1);
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }
  handleCommand(interaction, { manager, engines, defaultEngine: config.defaultEngine, log }).catch((error: unknown) =>
    log(`/${interaction.commandName} failed`, error),
  );
});

client.on(Events.MessageCreate, (message) => {
  if (!message.inGuild() || message.author.bot || message.system) {
    return;
  }
  if (message.channel.type === ChannelType.GuildVoice || message.channel.type === ChannelType.GuildStageVoice) {
    manager.handleMessage(message.guildId, message.channelId, message.cleanContent);
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = newState.guild.id;
  if (newState.id === client.user?.id) {
    manager.handleSelfVoiceState(guildId, newState.channelId);
    return;
  }
  if (oldState.channel && oldState.channelId !== newState.channelId) {
    manager.handleHumanCount(guildId, oldState.channel.id, countHumans(oldState.channel));
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log(`received ${signal}, closing sessions`);
  const timer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  await manager.closeAll();
  await client.destroy();
  clearTimeout(timer);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await client.login(config.discordToken);
